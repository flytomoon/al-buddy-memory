import { assertRestorable, edgeRestoreIsNoop } from "./immutable.js";
import { canonicalEdge, canonicalNode, instantMs } from "./instant.js";
import { assertVersion, assertVersionFitsNode, isHistoryCapable, versionsEqual } from "./history.js";
import type { GraphSnapshot, MemoryEdge, MemoryNode, MemoryStore, NodeVersion, SnapshotCapable } from "./types/memory.js";

/**
 * The portability proof — the artifact that makes "your memory outlives any
 * body" real instead of aspirational.
 *
 * One JSON document spanning every project silo, in two views:
 * - `projects` — LOSSLESS: every node and edge verbatim (bi-temporal history,
 *   anchors, Sealed included — it's the person's own export). Round-trippable
 *   via {@link importPortable}: import(export(store)) reproduces the store.
 * - `mcp` — INTEROP: the same graph flattened to the MCP memory-server
 *   entities/relations/observations shape, so any MCP-speaking runtime can
 *   load a useful (if shallower) copy today.
 */

export const PORTABLE_FORMAT_VERSION = "1.1.0";

export interface McpEntity {
  name: string; // nodeId — stable across runtimes
  entityType: string; // memoryType
  observations: string[]; // [content.text]
}

export interface McpRelation {
  from: string;
  to: string;
  relationType: string;
}

export interface PortableProject {
  project: string;
  nodes: MemoryNode[];
  edges: MemoryEdge[];
  versions?: NodeVersion[];
}

export interface PortableExport {
  formatVersion: string;
  exportedAt: string;
  projects: PortableProject[];
  mcp: { entities: McpEntity[]; relations: McpRelation[] };
}

export interface ImportSummary {
  nodes: number;
  edges: number;
}

/**
 * One project's whole graph, read as ONE state of the store.
 *
 * Export used to enumerate the nodes, then fetch each node's edges one await at
 * a time. A delete landing in the middle produced an artifact of two nodes and
 * zero edges — a graph that had never existed, and the "lossless backup" claim
 * does not survive that (Astra R6, reproduced in both stores, 2026-09-18).
 * Both shipped stores now answer `snapshot()` in one consistent read (SQLite in
 * a read transaction, the in-memory store without an await inside), and this
 * asks for it when it is there.
 *
 * A store that does NOT offer one — a governed `exportView`, or somebody else's
 * implementation of MemoryStore — still gets the old two-phase read, and its
 * export is only as consistent as the writes happening during it. Quiesce
 * writes when exporting through a wrapper. Across several projects the artifact
 * is one snapshot PER STORE, never one instant across all of them: they are
 * separate databases.
 */
async function graphOf(store: MemoryStore): Promise<GraphSnapshot & { versions?: NodeVersion[] }> {
  if (isHistoryCapable(store)) return store.historySnapshot();
  const capable = store as Partial<SnapshotCapable>;
  // Called before the first await on purpose: the snapshot is taken while this
  // function still holds the turn, so a caller's next write cannot slip inside.
  if (typeof capable.snapshot === "function") return capable.snapshot();
  // Every node — any validity, privacy or retention tier. Enumerating through
  // searchNodes silently dropped Archived and PendingDeletion facts, because
  // its default read hides them (review 2026-09-14).
  const nodes = await store.listNodes();
  const edgeById = new Map<string, MemoryEdge>();
  for (const node of nodes) {
    for (const edge of await store.getEdges(node.nodeId)) edgeById.set(edge.edgeId, edge);
  }
  return { nodes, edges: [...edgeById.values()] };
}

export async function exportPortable(
  stores: Map<string, MemoryStore>,
): Promise<PortableExport> {
  const projects: PortableProject[] = [];
  const entities: McpEntity[] = [];
  const relations: McpRelation[] = [];

  for (const [project, store] of stores) {
    const snapshot = await graphOf(store);
    const nodes = snapshot.nodes;
    const included = new Set(nodes.map((n) => n.nodeId));
    // Both ends must be in this export. Through a filtered view an edge to a
    // hidden fact would disclose its id and how it relates; in a full export
    // a dangling edge makes the artifact unimportable.
    const edges = snapshot.edges
      .filter((e) => included.has(e.sourceNodeId) && included.has(e.targetNodeId))
      .sort((a, b) => a.edgeId.localeCompare(b.edgeId));
    const versions = snapshot.versions?.filter((version) => included.has(version.nodeId)) ?? [];
    projects.push({ project, nodes, edges, versions });

    // MCP interop view is loadable into other AI runtimes, so it must NOT carry
    // Sealed content ("AI may not read/reference/summarize"). Sealed stays only
    // in the lossless owner backup above. (Security audit ALB-SEC-007.)
    const interopNodeIds = new Set<string>();
    for (const node of nodes) {
      if (node.privacyClassification === "Sealed") continue;
      interopNodeIds.add(node.nodeId);
      entities.push({
        name: node.nodeId,
        entityType: node.memoryType,
        observations: [node.content.text],
      });
    }
    for (const edge of edges) {
      // Drop relations touching a Sealed node — even the id/edge would leak.
      if (!interopNodeIds.has(edge.sourceNodeId) || !interopNodeIds.has(edge.targetNodeId)) {
        continue;
      }
      relations.push({
        from: edge.sourceNodeId,
        to: edge.targetNodeId,
        relationType: edge.relationshipType,
      });
    }
  }

  // Nothing in an export is dated after it. A store stamps a change a
  // millisecond past the fact's last entry while its clock is behind
  // (stampAfter in instant.ts), so the export moment is lifted past those too, or the artifact
  // would contradict itself and refuse to import (review 2026-09-22).
  let latest = Date.now();
  for (const p of projects) {
    for (const n of p.nodes) for (const a of n.temporalAnchors) latest = Math.max(latest, instantMs(a.timestamp) || 0);
    for (const v of p.versions ?? []) latest = Math.max(latest, instantMs(v.recordedAt) || 0);
  }
  const exportedAt = new Date(latest).toISOString();
  return {
    formatVersion: PORTABLE_FORMAT_VERSION,
    exportedAt,
    projects,
    mcp: { entities, relations },
  };
}

/**
 * Round-trip import: restore every node and edge verbatim into per-project
 * stores supplied by the caller. Idempotent — re-importing the same artifact
 * overwrites rather than duplicates.
 */
/**
 * Validate the WHOLE artifact before any store is touched, so a malformed or
 * tampered file is rejected up front instead of leaving a half-imported,
 * partially-destroyed memory graph. (ALB-SEC-006.)
 *
 * It used to say that and check the shape of six fields, while the real rules —
 * instants, weights, vocabulary, the creation anchor — lived in `restoreNode`,
 * one node too late: an artifact whose SECOND node carried `confidenceWeight:2`
 * imported the first node and then threw (Astra R5, reproduced in both stores).
 * So every rule a restore applies is applied here first, to every node and every
 * edge, with nothing written.
 *
 * What it still cannot promise is atomicity. A destination conflict it cannot
 * see (a policy refusal, a disk error, another writer between the check and the
 * write) can still stop an import part-way; {@link importPortable} says what to
 * do about that.
 */
function validatePortable(artifact: PortableExport): void {
  if (artifact.formatVersion !== "1.0.0" && artifact.formatVersion !== PORTABLE_FORMAT_VERSION) {
    throw new Error(
      `Unsupported portable format ${artifact.formatVersion} (expected 1.0.0 or ${PORTABLE_FORMAT_VERSION}).`,
    );
  }
  if (!Array.isArray(artifact.projects)) throw new Error("Invalid artifact: projects must be an array.");
  // Nothing in an export can have happened after the export was made. A fact or
  // a version dated later would decide what "as of now" says in the store that
  // imports it (release review 2026-09-21).
  const exportedAtMs = instantMs(artifact.exportedAt);
  if (!Number.isFinite(exportedAtMs)) throw new Error("Invalid artifact: exportedAt must be an ISO 8601 instant.");
  // An export from the future would pass the checks above and then fail part-way,
  // when each store checks a version against its own clock. Refused here, before
  // anything is written (review 2026-09-21). A device whose clock runs ahead:
  // wait until this clock passes exportedAt, or fix the clock.
  if (exportedAtMs > Date.now()) throw new Error(`Invalid artifact: exportedAt (${artifact.exportedAt}) is in the future; nothing was imported.`);
  const str = (v: unknown) => typeof v === "string";
  for (const project of artifact.projects) {
    if (!str(project.project)) throw new Error("Invalid artifact: project.project must be a string.");
    if (!Array.isArray(project.nodes) || !Array.isArray(project.edges)) {
      throw new Error(`Invalid artifact: project "${project.project}" nodes/edges must be arrays.`);
    }
    const where = `project "${project.project}"`;
    const seenNodes = new Set<string>();
    for (const n of project.nodes) {
      if (
        !str(n?.nodeId) ||
        !str(n?.encryptionKeyRef) ||
        typeof n?.content?.text !== "string" ||
        n?.contextualMetadata === null ||
        typeof n?.contextualMetadata !== "object" ||
        !Array.isArray(n?.temporalAnchors)
      ) {
        throw new Error(`Invalid artifact: malformed node in ${where}.`);
      }
      if (seenNodes.has(n.nodeId)) throw new Error(`Invalid artifact: ${where} lists node ${n.nodeId} twice.`);
      if (n.temporalAnchors.some((a) => instantMs(a?.timestamp) > exportedAtMs)) {
        throw new Error(`Invalid artifact: node ${n.nodeId} in ${where} has an anchor dated after the export (${artifact.exportedAt}).`);
      }
      seenNodes.add(n.nodeId);
      // Exactly what restoreNode would apply, node by node, before any of it is
      // written: instants with a zone, weights in range, the published
      // vocabulary, and a history that begins with "created".
      assertRestorable(canonicalNode(n));
    }
    const seenEdges = new Set<string>();
    for (const e of project.edges) {
      if (!str(e?.edgeId) || !str(e?.sourceNodeId) || !str(e?.targetNodeId)) {
        throw new Error(`Invalid artifact: malformed edge in ${where}.`);
      }
      if (seenEdges.has(e.edgeId)) throw new Error(`Invalid artifact: ${where} lists edge ${e.edgeId} twice.`);
      seenEdges.add(e.edgeId);
      canonicalEdge(e);
    }
    if (project.versions !== undefined && !Array.isArray(project.versions)) {
      throw new Error(`Invalid artifact: ${where} versions must be an array.`);
    }
    const seenVersions = new Set<string>();
    const nodesById = new Map(project.nodes.map((n) => [n.nodeId, n]));
    for (const version of project.versions ?? []) {
      assertVersion(version);
      if (seenVersions.has(version.versionId)) throw new Error(`Invalid artifact: ${where} lists version ${version.versionId} twice.`);
      seenVersions.add(version.versionId);
      const node = nodesById.get(version.nodeId);
      if (node === undefined) throw new Error(`Invalid artifact: version ${version.versionId} refers to node ${version.nodeId} outside ${where}.`);
      // History nobody recorded — dated before the fact, or a change its anchor
      // trail never saw — is refused here, before anything is written.
      try {
        assertVersionFitsNode(version, node, exportedAtMs);
      } catch (err) {
        throw new Error(`Invalid artifact: ${where}: ${err instanceof Error ? err.message : String(err)}.`);
      }
    }
  }
}

/**
 * The half of the preflight that needs the destination: a fact the store
 * already holds and this copy would rewrite, an edge that contradicts one
 * already recorded, and an edge endpoint that exists neither in the artifact
 * nor in the store. All reads; nothing is written.
 */
async function preflightDestination(project: PortableProject, store: MemoryStore, pending: PendingWrites): Promise<void> {
  const existingEdges = new Map<string, MemoryEdge>();
  for (const node of project.nodes) {
    const incoming = canonicalNode(node);
    const existing = await store.getNode(node.nodeId);
    assertRestorable(incoming, existing);
    // An earlier project in this artifact bound for the same store writes
    // first, so this copy must also restore cleanly over that one.
    const earlier = pending.nodes.get(node.nodeId);
    if (earlier !== undefined) assertRestorable(incoming, earlier);
    if (existing) for (const e of await store.getEdges(node.nodeId)) existingEdges.set(e.edgeId, e);
    pending.nodes.set(node.nodeId, incoming);
  }
  for (const edge of project.edges) {
    for (const id of [edge.sourceNodeId, edge.targetNodeId]) {
      if (pending.nodes.has(id)) continue;
      if (await store.getNode(id)) continue;
      throw new Error(`Invalid artifact: edge ${edge.edgeId} points at ${id}, which is neither in this artifact nor in the destination.`);
    }
    const incoming = canonicalEdge(edge);
    // Throws when the stored link, or one an earlier project will write, says
    // something different; true means the import is a no-op for it, which is fine.
    edgeRestoreIsNoop(incoming, existingEdges.get(edge.edgeId) ?? (await storedEdge(store, incoming)));
    edgeRestoreIsNoop(incoming, pending.edges.get(edge.edgeId));
    pending.edges.set(edge.edgeId, incoming);
  }
}

/** A link the store already holds under this id, looked up from either end. */
async function storedEdge(store: MemoryStore, edge: MemoryEdge): Promise<MemoryEdge | undefined> {
  for (const id of [edge.sourceNodeId, edge.targetNodeId]) {
    const found = (await store.getEdges(id)).find((e) => e.edgeId === edge.edgeId);
    if (found) return found;
  }
  return undefined;
}

/**
 * What the artifact will have written to one destination store by the time a
 * later project reaches it: two projects bound for the same store are checked
 * against each other, not only against the store as it stands (review
 * 2026-09-22).
 */
interface PendingWrites {
  nodes: Map<string, MemoryNode>;
  edges: Map<string, MemoryEdge>;
}

/**
 * Restore every node and edge verbatim. Nothing is written until the whole
 * artifact — every project, every node, every edge — has passed the structural
 * and semantic checks above AND the destination checks in
 * {@link preflightDestination}.
 *
 * Honest limit: this is a preflight, not a transaction. The stores are separate
 * databases and this interface has no cross-store commit, so a failure a check
 * cannot foresee (a policy refusal through a governed handle, a full disk,
 * another writer moving underneath) can still leave an import part-way. Import
 * into an empty store when you need all-or-nothing, and keep the artifact: the
 * import is idempotent, so running it again finishes the job.
 */
export async function importPortable(
  artifact: PortableExport,
  storeFor: (project: string) => MemoryStore,
): Promise<ImportSummary> {
  // Fail fast on the ENTIRE artifact before writing anything.
  validatePortable(artifact);
  const stores = new Map<PortableProject, MemoryStore>();
  // Version ids per destination store: what it already holds plus what this
  // artifact will write, so a clash is found before the first write rather than
  // after the nodes are in (release review 2026-09-21).
  const versionIds = new Map<MemoryStore, Map<string, NodeVersion>>();
  const pending = new Map<MemoryStore, PendingWrites>();
  for (const project of artifact.projects) {
    const store = storeFor(project.project);
    stores.set(project, store);
    let writes = pending.get(store);
    if (writes === undefined) {
      writes = { nodes: new Map(), edges: new Map() };
      pending.set(store, writes);
    }
    await preflightDestination(project, store, writes);
    if (!isHistoryCapable(store) || (project.versions ?? []).length === 0) continue;
    let known = versionIds.get(store);
    if (known === undefined) {
      known = new Map((await store.historySnapshot()).versions.map((v) => [v.versionId, v]));
      versionIds.set(store, known);
    }
    for (const version of project.versions ?? []) {
      const held = known.get(version.versionId);
      if (held !== undefined && !versionsEqual(held, version)) {
        throw new Error(`Invalid artifact: version ${version.versionId} is already recorded in the destination as a different change.`);
      }
      known.set(version.versionId, version);
    }
  }
  let nodes = 0;
  let edges = 0;
  for (const project of artifact.projects) {
    const store = stores.get(project)!;
    for (const node of project.nodes) {
      await store.restoreNode(node);
      nodes += 1;
    }
    for (const edge of project.edges) {
      await store.restoreEdge(edge);
      edges += 1;
    }
    if (isHistoryCapable(store)) {
      for (const version of project.versions ?? []) await store.restoreVersion(version);
    }
  }
  return { nodes, edges };
}
