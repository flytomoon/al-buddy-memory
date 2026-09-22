import { compareBinary, learnedAt } from "./decay.js";
import { canonicalInstant, canonicalPatch, instantMs } from "./instant.js";
import {
  MUTABLE_NODE_FIELDS,
  VERSION_EVENTS,
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
  const canonical = canonicalPatch(record as MutableNodeState);
  if (canonicalJson(canonical) !== canonicalJson(record)) {
    throw new Error(`${field} instants must be canonical`);
  }
}

/** Validate one portable/stored version with the same vocabulary rules as nodes. */
export function assertVersion(value: NodeVersion): void {
  if (value === null || typeof value !== "object") throw new Error("version must be an object");
  if (!UUID_V4.test(value.versionId)) throw new Error(`versionId must be a UUID v4; got ${JSON.stringify(value.versionId)}`);
  if (typeof value.nodeId !== "string" || value.nodeId.length === 0) throw new Error("version.nodeId must be a string");
  if (!(VERSION_EVENTS as readonly unknown[]).includes(value.event)) throw new Error(`unknown version event: ${String(value.event)}`);
  if (canonicalInstant(value.recordedAt, "version.recordedAt") !== value.recordedAt) {
    throw new Error("version.recordedAt must be canonical");
  }
  assertMutableImage(value.before, "version.before");
  assertMutableImage(value.after, "version.after");
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
  // after it. A stable sort keeps the store's order for same-instant changes.
  const ordered = [...versions].sort((a, b) => instantMs(a.recordedAt) - instantMs(b.recordedAt));

  let state: MutableNodeState;
  const happened = ordered.filter((version) => instantMs(version.recordedAt) <= at);
  if (happened.length > 0) state = happened[happened.length - 1]!.after;
  else if (ordered.length > 0) state = ordered[0]!.before;
  else state = mutableState(current);

  const anchors = current.temporalAnchors.filter((anchor) => instantMs(anchor.timestamp) <= at);
  // Exact only if every later change on the anchor trail has its OWN version:
  // same instant, same event. Matching counts per event let an unrelated
  // version stand in for an unrecorded change.
  const unmatched = new Map<string, number>();
  const key = (ms: number, event: string) => `${ms}|${event}`;
  for (const version of ordered) {
    if (version.event === "restored" || instantMs(version.recordedAt) <= at) continue;
    const k = key(instantMs(version.recordedAt), version.event);
    unmatched.set(k, (unmatched.get(k) ?? 0) + 1);
  }
  let exact = true;
  for (const anchor of current.temporalAnchors) {
    if (anchor.event === "created" || instantMs(anchor.timestamp) <= at) continue;
    const k = key(instantMs(anchor.timestamp), anchor.event);
    const left = unmatched.get(k) ?? 0;
    if (left === 0) { exact = false; break; }
    unmatched.set(k, left - 1);
  }
  return {
    node: { ...copy(current), ...copy(state), temporalAnchors: copy(anchors) },
    exact,
  };
}

/** Reconstruct a graph at one transaction instant. */
export function buildSnapshotAsOf(
  nodes: readonly MemoryNode[],
  edges: readonly MemoryEdge[],
  versionsByNode: ReadonlyMap<string, readonly NodeVersion[]>,
  asOfInput: string,
): AsOfSnapshot {
  const asOf = canonicalInstant(asOfInput, "asOf");
  const reconstructed: MemoryNode[] = [];
  const inexact: string[] = [];
  for (const current of nodes) {
    const result = nodeAsOf(current, versionsByNode.get(current.nodeId) ?? [], asOf);
    if (result.node === undefined) continue;
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
