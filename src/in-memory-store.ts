import { effectiveConfidence } from "./decay.js";
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
export class InMemoryStore implements MemoryStore {
  private readonly nodes = new Map<string, MemoryNode>();
  private readonly edges = new Map<string, MemoryEdge>();
  // Embeddings keyed by `${nodeId}::${model}` — one vector per (node, model).
  private readonly embeddings = new Map<string, MemoryEmbedding>();

  async addNode(node: NewMemoryNode): Promise<MemoryNode> {
    const now = new Date().toISOString();
    const full: MemoryNode = {
      ...node,
      nodeId: globalThis.crypto.randomUUID(),
      temporalAnchors: [{ timestamp: now, event: "created" }],
      // Valid-time defaults: fact is true from creation, open-ended.
      validFrom: node.validFrom ?? now,
      validTo: node.validTo ?? null,
    };
    this.nodes.set(full.nodeId, full);
    return full;
  }

  async getNode(nodeId: string): Promise<MemoryNode | undefined> {
    return this.nodes.get(nodeId);
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
        const tags = (n.contextualMetadata["tags"] as string[] | undefined) ?? [];
        return wanted.some((t) => tags.includes(t));
      });
    }
    if (options.minConfidence !== undefined) {
      const min = options.minConfidence;
      results = results.filter((n) => n.confidenceWeight >= min);
    }
    let relevance: Map<string, number> | undefined;
    if (options.query) {
      const q = options.query.toLowerCase();
      results = results.filter((n) => n.content.text.toLowerCase().includes(q));
      // Poor man's BM25: term frequency normalized by document length, so a
      // node that is *about* the query outranks one that mentions it once.
      relevance = new Map(
        results.map((n) => {
          const text = n.content.text.toLowerCase();
          const words = text.split(/\s+/).length;
          let occurrences = 0;
          for (let i = text.indexOf(q); i >= 0; i = text.indexOf(q, i + q.length)) occurrences += 1;
          return [n.nodeId, occurrences / Math.max(words, 1)];
        }),
      );
    }
    if (options.validAt !== undefined) {
      const at = options.validAt;
      // Valid-time window contains `at`: [validFrom, validTo) with null = open.
      results = results.filter((n) => n.validFrom <= at && (n.validTo === null || n.validTo > at));
    }

    const now = Date.now();
    const eff = new Map(results.map((n) => [n.nodeId, effectiveConfidence(n, now)]));
    if (relevance !== undefined) {
      const rel = relevance;
      results.sort(
        (a, b) =>
          (rel.get(b.nodeId) ?? 0) - (rel.get(a.nodeId) ?? 0) ||
          (eff.get(b.nodeId) ?? 0) - (eff.get(a.nodeId) ?? 0),
      );
    } else {
      results.sort((a, b) => (eff.get(b.nodeId) ?? 0) - (eff.get(a.nodeId) ?? 0));
    }

    if (options.after !== undefined) {
      const idx = results.findIndex((n) => n.nodeId === options.after);
      if (idx >= 0) results = results.slice(idx + 1);
    }
    if (options.limit !== undefined) {
      results = results.slice(0, options.limit);
    }
    return results;
  }

  async updateNode(
    nodeId: string,
    patch: Parameters<MemoryStore["updateNode"]>[1],
    anchorEvent: Parameters<MemoryStore["updateNode"]>[2] = "modified",
  ): Promise<MemoryNode> {
    const existing = this.nodes.get(nodeId);
    if (!existing) throw new Error(`Memory node not found: ${nodeId}`);
    const updated: MemoryNode = {
      ...existing,
      ...patch,
      temporalAnchors: [
        ...existing.temporalAnchors,
        { timestamp: new Date().toISOString(), event: anchorEvent },
      ],
    };
    this.nodes.set(nodeId, updated);
    return updated;
  }

  async restoreNode(node: MemoryNode): Promise<void> {
    this.nodes.set(node.nodeId, structuredClone(node));
  }

  async restoreEdge(edge: MemoryEdge): Promise<void> {
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
    const full: MemoryEdge = {
      ...edge,
      edgeId: globalThis.crypto.randomUUID(),
      createdAt: new Date().toISOString(),
    };
    this.edges.set(full.edgeId, full);
    return full;
  }

  async getEdges(nodeId: string): Promise<MemoryEdge[]> {
    return [...this.edges.values()].filter(
      (e) => e.sourceNodeId === nodeId || e.targetNodeId === nodeId,
    );
  }

  async deleteEdge(edgeId: string): Promise<void> {
    this.edges.delete(edgeId);
  }

  async setEmbedding(embedding: Omit<MemoryEmbedding, "createdAt">): Promise<MemoryEmbedding> {
    const full: MemoryEmbedding = { ...embedding, createdAt: new Date().toISOString() };
    this.embeddings.set(`${full.nodeId}::${full.model}`, full);
    return full;
  }

  async getEmbeddings(nodeId: string): Promise<MemoryEmbedding[]> {
    return [...this.embeddings.values()].filter((e) => e.nodeId === nodeId);
  }

  async listEmbeddings(model: string): Promise<MemoryEmbedding[]> {
    return [...this.embeddings.values()].filter((e) => e.model === model);
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
