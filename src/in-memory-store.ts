import { compareRecency, effectiveConfidence } from "./decay.js";
import { assertPatchMutable, assertRestorable, edgeRestoreIsNoop } from "./immutable.js";
import { canonicalEdge, canonicalInstant, canonicalNew, canonicalNode, canonicalPatch } from "./instant.js";
import { queryTokens, visibleRelevance } from "./query-filter.js";
import type {
  MemoryEdge,
  MemoryEmbedding,
  MemoryNode,
  MemoryQueryOptions,
  MemoryStore,
  NewMemoryNode,
} from "./types/memory.js";

/**
 * Volatile in-memory implementation of the memory graph (GOV-DAT-001 §2).
 * Faithful to the {@link MemoryStore} interface — nodes + typed edges — but
 * held in Maps, so it forgets on restart. Good for tests, short sessions,
 * and standing up an interface before the persistent (SQLite) backend is
 * wired. Swap for a durable store without changing any caller.
 */
/**
 * Every object crosses the boundary as a copy, in and out. The store used to
 * hold the caller's object and hand back its own, so `node.temporalAnchors.length = 0`
 * on a returned fact rewrote history with no anchor and no audit (review
 * 2026-09-14). SQLite gets this for free by serialising; this store has to do it.
 */
const copy = <T>(value: T): T => structuredClone(value);

export class InMemoryStore implements MemoryStore {
  private readonly nodes = new Map<string, MemoryNode>();
  private readonly edges = new Map<string, MemoryEdge>();
  // Embeddings keyed by `${nodeId}::${model}` — one vector per (node, model).
  private readonly embeddings = new Map<string, MemoryEmbedding>();

  async addNode(input: NewMemoryNode): Promise<MemoryNode> {
    const node = canonicalNew(input);
    const now = new Date().toISOString();
    const full: MemoryNode = {
      ...node,
      nodeId: globalThis.crypto.randomUUID(),
      temporalAnchors: [{ timestamp: now, event: "created" }],
      // Valid-time defaults: fact is true from creation, open-ended.
      validFrom: node.validFrom ?? now,
      validTo: node.validTo ?? null,
    };
    this.nodes.set(full.nodeId, copy(full));
    return copy(full);
  }

  async listNodes(): Promise<MemoryNode[]> {
    return [...this.nodes.values()].sort((a, b) => compareRecency(b, a)).map(copy);
  }

  async getNode(nodeId: string): Promise<MemoryNode | undefined> {
    const node = this.nodes.get(nodeId);
    return node === undefined ? undefined : copy(node);
  }

  async searchNodes(options: MemoryQueryOptions): Promise<MemoryNode[]> {
    let results = [...this.nodes.values()];

    if (options.memoryType !== undefined) {
      const types = Array.isArray(options.memoryType) ? options.memoryType : [options.memoryType];
      results = results.filter((n) => types.includes(n.memoryType));
    }
    if (options.privacyClassification?.length) {
      const allowed = options.privacyClassification;
      results = results.filter((n) => allowed.includes(n.privacyClassification));
    } else {
      // Governance boundary: Sealed nodes never surface unless explicitly requested.
      results = results.filter((n) => n.privacyClassification !== "Sealed");
    }
    if (options.retentionTier?.length) {
      const allowed = options.retentionTier;
      results = results.filter((n) => allowed.includes(n.retentionTier));
    } else {
      // Archived / PendingDeletion stay out of active context unless named.
      results = results.filter((n) => n.retentionTier !== "Archived" && n.retentionTier !== "PendingDeletion");
    }
    if (options.tags?.length) {
      const wanted = options.tags;
      results = results.filter((n) => {
        const tags = n.contextualMetadata["tags"];
        return Array.isArray(tags) && wanted.some((t) => (tags as unknown[]).includes(t));
      });
    }
    if (options.minConfidence !== undefined) {
      const min = options.minConfidence;
      results = results.filter((n) => n.confidenceWeight >= min);
    }
    // Keyword matching as SQLite's FTS reads a query: any of its words, whole words,
    // case-insensitive; no usable words matches nothing. This store used to match
    // the whole query as one substring, so "what is the wifi login" found nothing
    // here that SQLite found (Astra A10; Fable, 2026-09-15).
    let tokens: string[] | undefined;
    if (options.query !== undefined) {
      tokens = queryTokens(options.query).map((t) => t.toLowerCase());
      if (tokens.length === 0) return [];
      const wanted = new Set(tokens);
      results = results.filter((n) => (n.content.text.match(/[\p{L}\p{N}]+/gu) ?? []).some((w) => wanted.has(w.toLowerCase())));
    }
    if (options.validAt !== undefined) {
      const at = canonicalInstant(options.validAt, "validAt");
      // Valid-time window contains `at`: [validFrom, validTo) with null = open.
      results = results.filter((n) => n.validFrom <= at && (n.validTo === null || n.validTo > at));
    }

    const now = Date.now();
    const eff = new Map(results.map((n) => [n.nodeId, effectiveConfidence(n, now)]));
    // Relevance over the final matches: word share weighted by rarity among them.
    const scores = tokens === undefined ? undefined : visibleRelevance(results.map((n) => n.content.text), tokens);
    const relevance = scores === undefined ? undefined : new Map(results.map((n, i) => [n.nodeId, scores[i]!]));
    if (relevance !== undefined) {
      const rel = relevance;
      results.sort(
        (a, b) =>
          (rel.get(b.nodeId) ?? 0) - (rel.get(a.nodeId) ?? 0) ||
          (eff.get(b.nodeId) ?? 0) - (eff.get(a.nodeId) ?? 0) ||
          compareRecency(a, b),
      );
    } else {
      // The same tie-break the SQLite store uses (compareRecency): equal
      // confidence — every fact with decayRate 0 — resolves newest first, so
      // both stores answer a limited read with the same page. Insertion order
      // used to decide it here, which only looked right because this store
      // reads everything and never has a candidate pool.
      results.sort((a, b) => (eff.get(b.nodeId) ?? 0) - (eff.get(a.nodeId) ?? 0) || compareRecency(a, b));
    }

    if (options.after !== undefined) {
      const idx = results.findIndex((n) => n.nodeId === options.after);
      if (idx >= 0) results = results.slice(idx + 1);
    }
    if (options.limit !== undefined) {
      results = results.slice(0, options.limit);
    }
    return results.map(copy);
  }

  async updateNode(
    nodeId: string,
    patch: Parameters<MemoryStore["updateNode"]>[1],
    anchorEvent: Parameters<MemoryStore["updateNode"]>[2] = "modified",
  ): Promise<MemoryNode> {
    const existing = this.nodes.get(nodeId);
    if (!existing) throw new Error(`Memory node not found: ${nodeId}`);
    assertPatchMutable(patch);
    const updated: MemoryNode = {
      ...copy(existing),
      ...copy(canonicalPatch(patch)),
      temporalAnchors: [
        ...existing.temporalAnchors,
        { timestamp: new Date().toISOString(), event: anchorEvent },
      ],
    };
    this.nodes.set(nodeId, updated);
    return copy(updated);
  }

  async restoreNode(input: MemoryNode): Promise<void> {
    const node = canonicalNode(input);
    assertRestorable(node, this.nodes.get(node.nodeId));
    this.nodes.set(node.nodeId, copy(node));
  }

  /** The same referential rule SQLite's foreign keys enforce, so the stores agree. */
  private assertEndpoints(edge: Pick<MemoryEdge, "sourceNodeId" | "targetNodeId">): void {
    for (const id of [edge.sourceNodeId, edge.targetNodeId]) {
      if (!this.nodes.has(id)) throw new Error(`edge endpoint not found: ${id}`);
    }
  }

  async restoreEdge(input: MemoryEdge): Promise<void> {
    const edge = canonicalEdge(input);
    if (edgeRestoreIsNoop(edge, this.edges.get(edge.edgeId))) return;
    this.assertEndpoints(edge);
    this.edges.set(edge.edgeId, structuredClone(edge));
  }

  async deleteNode(nodeId: string): Promise<void> {
    this.nodes.delete(nodeId);
    for (const [id, edge] of this.edges) {
      if (edge.sourceNodeId === nodeId || edge.targetNodeId === nodeId) {
        this.edges.delete(id);
      }
    }
    // Embeddings are derived from the node — drop them with it.
    for (const key of this.embeddings.keys()) {
      if (key.startsWith(`${nodeId}::`)) this.embeddings.delete(key);
    }
  }

  async addEdge(edge: Omit<MemoryEdge, "edgeId" | "createdAt">): Promise<MemoryEdge> {
    this.assertEndpoints(edge);
    const full: MemoryEdge = {
      ...edge,
      edgeId: globalThis.crypto.randomUUID(),
      createdAt: new Date().toISOString(),
    };
    this.edges.set(full.edgeId, copy(full));
    return copy(full);
  }

  async getEdges(nodeId: string): Promise<MemoryEdge[]> {
    return [...this.edges.values()]
      .filter((e) => e.sourceNodeId === nodeId || e.targetNodeId === nodeId)
      .map(copy);
  }

  async deleteEdge(edgeId: string): Promise<void> {
    this.edges.delete(edgeId);
  }

  async setEmbedding(embedding: Omit<MemoryEmbedding, "createdAt">): Promise<MemoryEmbedding> {
    if (!this.nodes.has(embedding.nodeId)) throw new Error(`embedding node not found: ${embedding.nodeId}`);
    const full: MemoryEmbedding = { ...copy(embedding), createdAt: new Date().toISOString() };
    this.embeddings.set(`${full.nodeId}::${full.model}`, full);
    return copy(full);
  }

  async getEmbeddings(nodeId: string): Promise<MemoryEmbedding[]> {
    return [...this.embeddings.values()].filter((e) => e.nodeId === nodeId).map(copy);
  }

  async listEmbeddings(model: string): Promise<MemoryEmbedding[]> {
    return [...this.embeddings.values()].filter((e) => e.model === model).map(copy);
  }

  async deleteEmbeddings(nodeId: string, model?: string): Promise<void> {
    if (model !== undefined) {
      this.embeddings.delete(`${nodeId}::${model}`);
      return;
    }
    for (const key of this.embeddings.keys()) {
      if (key.startsWith(`${nodeId}::`)) this.embeddings.delete(key);
    }
  }

  /** Convenience for tests/callers — number of nodes held. */
  get size(): number {
    return this.nodes.size;
  }
}
