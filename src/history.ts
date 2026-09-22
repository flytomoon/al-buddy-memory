import { compareBinary, learnedAt } from "./decay.js";
import { canonicalInstant, instantMs } from "./instant.js";
import {
  MUTABLE_NODE_FIELDS,
  VERSION_EVENTS,
  type AsOfOptions,
  type AsOfSnapshot,
  type HistoryCapable,
  type MemoryEdge,
  type MemoryNode,
  type MutableNodeState,
  type NodeVersion,
} from "./types/memory.js";

const copy = <T>(value: T): T => structuredClone(value);
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** The full mutable image of a fact, detached from the caller's object. */
export function mutableState(node: MemoryNode): MutableNodeState {
  return {
    memoryType: node.memoryType,
    privacyClassification: node.privacyClassification,
    retentionTier: node.retentionTier,
    contextualMetadata: copy(node.contextualMetadata),
    validFrom: node.validFrom,
    validTo: node.validTo,
    confidenceWeight: node.confidenceWeight,
    decayRate: node.decayRate,
  };
}

/** Key-order-independent JSON, for comparing stored images. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.keys(item as object).sort().map((key) => [key, (item as Record<string, unknown>)[key]]))
      : item,
  );
}

export function mutableStatesEqual(a: MutableNodeState, b: MutableNodeState): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

export function versionsEqual(a: NodeVersion, b: NodeVersion): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

function assertMutableImage(value: unknown, field: string): asserts value is MutableNodeState {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be a full mutable node image`);
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expected = [...MUTABLE_NODE_FIELDS].sort();
  if (canonicalJson(keys) !== canonicalJson(expected)) {
    throw new Error(`${field} must contain exactly every mutable node field`);
  }
  if (record["contextualMetadata"] === null || typeof record["contextualMetadata"] !== "object" || Array.isArray(record["contextualMetadata"])) {
    throw new Error(`${field}.contextualMetadata must be an object`);
  }
  // Shape and types only. A history image is what the store held, and a store
  // from before 0.4.0 can have held a word outside today's vocabulary, a weight
  // above 1, an instant it never parsed. Refusing those refused a store's own
  // export (release review 2026-09-21). Today's rules apply to the fact as it is
  // now, which every write path still checks.
  for (const key of ["memoryType", "privacyClassification", "retentionTier", "validFrom"] as const) {
    if (typeof record[key] !== "string") throw new Error(`${field}.${key} must be a string`);
  }
  if (record["validTo"] !== null && typeof record["validTo"] !== "string") throw new Error(`${field}.validTo must be a string or null`);
  for (const key of ["confidenceWeight", "decayRate"] as const) {
    if (typeof record[key] !== "number" || !Number.isFinite(record[key])) throw new Error(`${field}.${key} must be a finite number`);
  }
}

/** Validate one portable/stored version with the same vocabulary rules as nodes. */
const VERSION_KEYS = ["after", "before", "event", "nodeId", "recordedAt", "versionId"];

export function assertVersion(value: NodeVersion): void {
  if (value === null || typeof value !== "object") throw new Error("version must be an object");
  // Exactly these six: the schema says additionalProperties false, and a store
  // that kept an extra key would re-export an artifact the schema refuses.
  if (canonicalJson(Object.keys(value).sort()) !== canonicalJson(VERSION_KEYS)) {
    throw new Error(`version must have exactly ${VERSION_KEYS.join(", ")}`);
  }
  if (!UUID_V4.test(value.versionId)) throw new Error(`versionId must be a UUID v4; got ${JSON.stringify(value.versionId)}`);
  if (typeof value.nodeId !== "string" || value.nodeId.length === 0) throw new Error("version.nodeId must be a string");
  if (!(VERSION_EVENTS as readonly unknown[]).includes(value.event)) throw new Error(`unknown version event: ${String(value.event)}`);
  if (canonicalInstant(value.recordedAt, "version.recordedAt") !== value.recordedAt) {
    throw new Error("version.recordedAt must be canonical");
  }
  assertMutableImage(value.before, "version.before");
  assertMutableImage(value.after, "version.after");
}

/**
 * A version the store itself would have written sits on the fact's anchor trail:
 * never before the fact was learned, and (unless it is a `restored` version,
 * which carries no anchor) at the same instant and event as an anchor. An
 * imported version that fits neither is history nobody recorded: refused at
 * import, before anything is written.
 */
export function assertVersionFitsNode(version: NodeVersion, node: MemoryNode, notAfterMs: number = Date.now()): void {
  const at = instantMs(version.recordedAt);
  if (at < instantMs(learnedAt(node))) {
    throw new Error(`version ${version.versionId} is dated before its fact was learned`);
  }
  if (version.event !== "restored" && !node.temporalAnchors.some((a) => a.event === version.event && instantMs(a.timestamp) === at)) {
    throw new Error(`version ${version.versionId} records a "${version.event}" at ${version.recordedAt} that its fact's anchor trail does not`);
  }
  // A version from the future would decide what "as of now" says, and a
  // `restored` one needs no anchor to do it (release review 2026-09-21). Nothing
  // is recorded after the moment it is written, or after the export it came in.
  if (at > notAfterMs) {
    throw new Error(`version ${version.versionId} is dated in the future (${version.recordedAt})`);
  }
}

/** Versions in the order the changes happened. Stable, so same-instant changes keep the store's order. */
export function orderVersions<T extends Pick<NodeVersion, "recordedAt">>(versions: readonly T[]): T[] {
  return [...versions].sort((a, b) => instantMs(a.recordedAt) - instantMs(b.recordedAt));
}

/** Reconstruct one fact and say whether recorded history fully supports it. */
export function nodeAsOf(
  current: MemoryNode,
  versions: readonly NodeVersion[],
  asOfInput: string,
): { node: MemoryNode | undefined; exact: boolean } {
  const asOf = canonicalInstant(asOfInput, "asOf");
  const at = instantMs(asOf);
  if (instantMs(learnedAt(current)) > at) return { node: undefined, exact: true };

  // Time order, not insertion order: re-importing over an existing fact records
  // a "restored" version now and then inserts the artifact's older versions
  // after it.
  const ordered = orderVersions(versions);
  const happened = ordered.filter((version) => instantMs(version.recordedAt) <= at);
  const later = ordered.filter((version) => instantMs(version.recordedAt) > at);

  // With nothing recorded after asOf, the answer is the fact as it is: as of now
  // is always the present, even when history does not explain how it got there.
  let state: MutableNodeState;
  if (later.length === 0) state = mutableState(current);
  else if (happened.length > 0) state = happened[happened.length - 1]!.after;
  else state = later[0]!.before;

  const anchors = current.temporalAnchors.filter((anchor) => instantMs(anchor.timestamp) <= at);
  return { node: { ...copy(current), ...copy(state), temporalAnchors: copy(anchors) }, exact: explains(current, ordered, at, state) };
}

/**
 * Whether the recorded history accounts for the fact from `at` to now. Every
 * test here is one way a past read could be wrong while looking right:
 * - the chain must join: each version starts where the one before it ended;
 * - it must end at the fact as stored (a write policy that reshaped an
 *   imported fact, or a change made by an older library, breaks this);
 * - every later change on the anchor trail needs its own version, same instant
 *   and event, and every later version (other than `restored`) its own anchor.
 */
function explains(current: MemoryNode, ordered: readonly NodeVersion[], at: number, served: MutableNodeState): boolean {
  // The chain matters from the state in force at `at` onward: a break further
  // back cannot make this read wrong. And a `restored` version whose result the
  // chain already reached is redundant: refreshing a store from a newer backup
  // records one after the backup's own versions, and it must not mark the fact
  // inexact for ever (release review 2026-09-21). But it is redundant only
  // from the moment it was recorded: before that, this store held its `before`
  // image, not the joined-in versions it skips, so a read in that window that
  // serves anything else is the seam SPEC §8 says is marked (review 2026-09-22).
  let start = 0;
  for (let i = 0; i < ordered.length; i++) if (instantMs(ordered[i]!.recordedAt) <= at) start = i;
  let reached: MutableNodeState | null = null;
  for (const version of ordered.slice(start)) {
    if (reached !== null && !mutableStatesEqual(reached, version.before)) {
      if (version.event === "restored" && mutableStatesEqual(reached, version.after)) {
        if (instantMs(version.recordedAt) > at && !mutableStatesEqual(served, version.before)) return false;
        continue;
      }
      return false;
    }
    reached = version.after;
  }
  if (reached !== null && !mutableStatesEqual(reached, mutableState(current))) return false;
  const key = (ms: number, event: string) => `${ms}|${event}`;
  const versionsLeft = new Map<string, number>();
  for (const version of ordered) {
    if (version.event === "restored" || instantMs(version.recordedAt) <= at) continue;
    const k = key(instantMs(version.recordedAt), version.event);
    versionsLeft.set(k, (versionsLeft.get(k) ?? 0) + 1);
  }
  for (const anchor of current.temporalAnchors) {
    if (anchor.event === "created" || instantMs(anchor.timestamp) <= at) continue;
    const k = key(instantMs(anchor.timestamp), anchor.event);
    const left = versionsLeft.get(k) ?? 0;
    if (left === 0) return false;
    versionsLeft.set(k, left - 1);
  }
  return [...versionsLeft.values()].every((n) => n === 0);
}

/** Reconstruct a graph at one transaction instant. */
export function buildSnapshotAsOf(
  nodes: readonly MemoryNode[],
  edges: readonly MemoryEdge[],
  versionsByNode: ReadonlyMap<string, readonly NodeVersion[]>,
  asOfInput: string,
  options: AsOfOptions = {},
): AsOfSnapshot {
  const asOf = canonicalInstant(asOfInput, "asOf");
  // "What did we believe at X about what was true at Y": valid time is filtered
  // on the reconstructed window, the one the store held at X.
  const validAt = options.validAt === undefined ? undefined : instantMs(canonicalInstant(options.validAt, "validAt"));
  const reconstructed: MemoryNode[] = [];
  const inexact: string[] = [];
  for (const current of nodes) {
    const result = nodeAsOf(current, versionsByNode.get(current.nodeId) ?? [], asOf);
    if (result.node === undefined) continue;
    if (validAt !== undefined) {
      const n = result.node;
      if (instantMs(n.validFrom) > validAt || (n.validTo !== null && instantMs(n.validTo) <= validAt)) continue;
    }
    reconstructed.push(result.node);
    if (!result.exact) inexact.push(current.nodeId);
  }
  reconstructed.sort((a, b) => instantMs(learnedAt(a)) - instantMs(learnedAt(b)) || compareBinary(a.nodeId, b.nodeId));
  inexact.sort(compareBinary);
  const included = new Set(reconstructed.map((node) => node.nodeId));
  const at = instantMs(asOf);
  const visibleEdges = edges
    .filter((edge) => instantMs(edge.createdAt) <= at && included.has(edge.sourceNodeId) && included.has(edge.targetNodeId))
    .map(copy)
    .sort((a, b) => compareBinary(a.edgeId, b.edgeId));
  return { nodes: reconstructed, edges: visibleEdges, asOf, inexact };
}

export function isHistoryCapable(store: unknown): store is HistoryCapable {
  if (store === null || typeof store !== "object") return false;
  const candidate = store as Partial<HistoryCapable>;
  return typeof candidate.history === "function" &&
    typeof candidate.getNodeAsOf === "function" &&
    typeof candidate.snapshotAsOf === "function" &&
    typeof candidate.historySnapshot === "function" &&
    typeof candidate.restoreVersion === "function";
}
