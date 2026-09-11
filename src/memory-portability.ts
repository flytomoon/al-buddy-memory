import type { MemoryEdge, MemoryNode, MemoryStore } from "./types/memory.js";

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

export const PORTABLE_FORMAT_VERSION = "1.0.0";

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

/** Every node in a store — currently valid, retired, and Sealed alike. */
async function allNodes(store: MemoryStore): Promise<MemoryNode[]> {
  const open = await store.searchNodes({});
  const sealed = await store.searchNodes({ privacyClassification: ["Sealed"] });
  return [...open, ...sealed];
}

export async function exportPortable(
  stores: Map<string, MemoryStore>,
): Promise<PortableExport> {
  const projects: PortableProject[] = [];
  const entities: McpEntity[] = [];
  const relations: McpRelation[] = [];

  for (const [project, store] of stores) {
    const nodes = await allNodes(store);
    const edgeById = new Map<string, MemoryEdge>();
    for (const node of nodes) {
      for (const edge of await store.getEdges(node.nodeId)) {
        edgeById.set(edge.edgeId, edge);
      }
    }
    const edges = [...edgeById.values()];
    projects.push({ project, nodes, edges });

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

  return {
    formatVersion: PORTABLE_FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
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
 */
function validatePortable(artifact: PortableExport): void {
  if (artifact.formatVersion !== PORTABLE_FORMAT_VERSION) {
    throw new Error(
      `Unsupported portable format ${artifact.formatVersion} (expected ${PORTABLE_FORMAT_VERSION}).`,
    );
  }
  if (!Array.isArray(artifact.projects)) throw new Error("Invalid artifact: projects must be an array.");
  const str = (v: unknown) => typeof v === "string";
  for (const project of artifact.projects) {
    if (!str(project.project)) throw new Error("Invalid artifact: project.project must be a string.");
    if (!Array.isArray(project.nodes) || !Array.isArray(project.edges)) {
      throw new Error(`Invalid artifact: project "${project.project}" nodes/edges must be arrays.`);
    }
    for (const n of project.nodes) {
      if (
        !str(n?.nodeId) ||
        !str(n?.memoryType) ||
        !str(n?.privacyClassification) ||
        !str(n?.validFrom) ||
        typeof n?.content?.text !== "string" ||
        typeof n?.confidenceWeight !== "number" ||
        !Array.isArray(n?.temporalAnchors)
      ) {
        throw new Error(`Invalid artifact: malformed node in project "${project.project}".`);
      }
    }
    for (const e of project.edges) {
      if (!str(e?.edgeId) || !str(e?.sourceNodeId) || !str(e?.targetNodeId) || !str(e?.relationshipType)) {
        throw new Error(`Invalid artifact: malformed edge in project "${project.project}".`);
      }
    }
  }
}

export async function importPortable(
  artifact: PortableExport,
  storeFor: (project: string) => MemoryStore,
): Promise<ImportSummary> {
  // Fail fast on the ENTIRE artifact before writing anything.
  validatePortable(artifact);
  let nodes = 0;
  let edges = 0;
  for (const project of artifact.projects) {
    const store = storeFor(project.project);
    for (const node of project.nodes) {
      await store.restoreNode(node);
      nodes += 1;
    }
    for (const edge of project.edges) {
      await store.restoreEdge(edge);
      edges += 1;
    }
  }
  return { nodes, edges };
}
