import { compareBinary, compareRecency, effectiveConfidence } from "./decay.js";
import { canonicalInstant } from "./instant.js";
import type { MemoryNode, MemoryStore, MemoryEmbedding } from "./types/memory.js";
import type { Embedder } from "./embedder.js";
import { cosineSimilarity } from "./embedder.js";
import { matchesFilter, type NodeFilter } from "./query-filter.js";

/**
 * Hybrid recall: keyword relevance (FTS/BM25) fused with vector similarity.
 *
 * This is what makes recall hold up as the store grows — FTS alone can't find
 * "moved to Tokyo" when you ask about "living in Japan", and static confidence
 * ordering degrades to noise at thousands of nodes. Reciprocal-rank fusion
 * combines both signals without fragile score normalization; when no embedder
 * is configured everything degrades gracefully to keyword-only.
 */

export interface RecallOptions extends Omit<NodeFilter, "validAt"> {
  limit?: number;
  /** Bi-temporal instant; defaults to now (only currently-valid facts). */
  validAt?: string;
}

const CANDIDATE_POOL = 50;
const RRF_K = 60; // standard reciprocal-rank-fusion constant
/** Cosine similarity above which two texts state the same fact. */
const DUPLICATE_THRESHOLD = 0.9;
/** Confidence bump when a duplicate observation reinforces a node. */
const REINFORCE_STEP = 0.05;

export class HybridRetriever {
  /**
   * The vector matrix, held for a moment. Every recall used to JSON-parse
   * every stored vector, and the curator + reconciler recall once per fact,
   * so one chatty message parsed the whole store ~8× (review 2026-09-01,
   * idea 6). A short TTL covers that burst; another process writing
   * embeddings is seen within the TTL, and this retriever's own writes
   * clear it at once.
   */
  private vectorCache: { model: string; at: number; rows: MemoryEmbedding[] } | null = null;

  constructor(
    private readonly store: MemoryStore,
    private readonly embedder?: Embedder,
    private readonly opts: { cacheTtlMs?: number; now?: () => number } = {},
  ) {}

  private async embeddingsFor(model: string): Promise<MemoryEmbedding[]> {
    const now = (this.opts.now ?? Date.now)();
    const ttl = this.opts.cacheTtlMs ?? 60_000;
    const c = this.vectorCache;
    if (c && c.model === model && now - c.at < ttl) return c.rows;
    const rows = await this.store.listEmbeddings(model);
    this.vectorCache = { model, at: now, rows };
    return rows;
  }

  async recall(query: string, options: RecallOptions = {}): Promise<MemoryNode[]> {
    const limit = options.limit ?? 5;
    const validAt = options.validAt === undefined ? new Date().toISOString() : canonicalInstant(options.validAt, "validAt");

    // Scope (type, tags, confidence, privacy / retention tiers) applies to BOTH
    // lists, with the store's own semantics, so a scoped recall can never pull
    // an out-of-scope fact in through the vector side.
    const { limit: _limit, validAt: _validAt, ...scope } = options;
    const filter: NodeFilter = { ...scope, validAt };

    // Keyword list — BM25-ordered by the store.
    const keywordHits = await this.store.searchNodes({ ...filter, query, limit: CANDIDATE_POOL });

    // Vector list — full scan of the embedder's model space (local scale).
    const vectorHits = await this.vectorCandidates(query, filter);

    // Reciprocal-rank fusion across both lists.
    const scores = new Map<string, { score: number; node: MemoryNode }>();
    const addList = (nodes: MemoryNode[]) => {
      nodes.forEach((node, index) => {
        const entry = scores.get(node.nodeId) ?? { score: 0, node };
        entry.score += 1 / (RRF_K + index + 1);
        scores.set(node.nodeId, entry);
      });
    };
    addList(keywordHits);
    addList(vectorHits.map((v) => v.node));

    // The same order as the stores: fused rank, then EFFECTIVE confidence (it
    // compared stored confidence, so a fact decayed to half its weight still won
    // the tie), then the most recently learned. A fused tie is the ordinary
    // shape of reciprocal-rank fusion: one fact wins the keyword list, the other
    // the vector list, and 1/61 + 1/62 is the same number both ways.
    const now = Date.now();
    return [...scores.values()]
      .map((e) => ({ ...e, eff: effectiveConfidence(e.node, now) }))
      .sort((a, b) => b.score - a.score || b.eff - a.eff || compareRecency(a.node, b.node))
      .slice(0, limit)
      .map((e) => e.node);
  }

  /**
   * Is this fact already known (semantically, not just verbatim)? Used on
   * capture so repeated observations reinforce instead of accumulating
   * duplicates. Embedder required — keyword overlap alone is too coarse to
   * declare two sentences the same fact.
   */
  async findDuplicate(text: string): Promise<MemoryNode | undefined> {
    if (!this.embedder) return undefined;
    const validAt = new Date().toISOString();
    const candidates = await this.vectorCandidates(text, { validAt });
    const top = candidates[0];
    return top !== undefined && top.similarity >= DUPLICATE_THRESHOLD ? top.node : undefined;
  }

  /** Embed one node immediately (capture path) so recall sees it right away. */
  async indexNode(node: MemoryNode): Promise<void> {
    this.vectorCache = null;
    if (!this.embedder) return;
    const [vector] = await this.embedder.embed([node.content.text]);
    if (!vector) return;
    await this.store.setEmbedding({
      nodeId: node.nodeId,
      model: this.embedder.model,
      modelVersion: this.embedder.modelVersion,
      dimensions: this.embedder.dimensions,
      metric: "cosine",
      vector,
    });
  }

  /** Strengthen a node a duplicate observation just confirmed. */
  async reinforce(nodeId: string): Promise<MemoryNode> {
    const node = await this.store.getNode(nodeId);
    if (!node) throw new Error(`Cannot reinforce missing node: ${nodeId}`);
    const confidenceWeight = Math.min(1, node.confidenceWeight + REINFORCE_STEP);
    return this.store.updateNode(nodeId, { confidenceWeight }, "reinforced");
  }

  private async vectorCandidates(
    query: string,
    filter: NodeFilter,
  ): Promise<{ node: MemoryNode; similarity: number }[]> {
    if (!this.embedder) return [];
    const [queryVector] = await this.embedder.embed([query]);
    if (!queryVector) return [];
    const embeddings = await this.embeddingsFor(this.embedder.model);

    // A vector of another length is from another model version: its cosine
    // against this query is meaningless (a shorter one used to score NaN, and
    // NaN made the sort non-transitive, so the winner depended on insertion
    // order). Skip it; backfill replaces it.
    const scored = embeddings
      .filter((e) => e.vector.length === queryVector.length)
      .map((e) => ({ nodeId: e.nodeId, similarity: cosineSimilarity(queryVector, e.vector) }))
      .filter((e) => Number.isFinite(e.similarity))
      .sort((a, b) => b.similarity - a.similarity || compareBinary(a.nodeId, b.nodeId));

    // Filter BEFORE taking the pool: with a scope, the nearest 50 vectors may all
    // be out of scope, and slicing first would leave the vector list empty. And
    // finish the similarity tie group at the boundary: two recordings of one fact
    // have IDENTICAL similarity (the vector is a function of the text), so which
    // of them makes the pool — and which one findDuplicate reinforces — has to be
    // decided by the fact, not by where the cut fell (review 2026-09-14; the 0.3.5
    // comment here claimed recency settled it, and nothing did).
    const out: { node: MemoryNode; similarity: number }[] = [];
    for (const { nodeId, similarity } of scored) {
      if (out.length >= CANDIDATE_POOL && similarity < out[out.length - 1]!.similarity) break;
      const node = await this.store.getNode(nodeId);
      if (!node) continue;
      // Same boundary as searchNodes: in scope, currently valid, never Sealed,
      // never Archived / PendingDeletion unless the scope names them.
      if (!matchesFilter(node, filter)) continue;
      out.push({ node, similarity });
    }
    const now = Date.now();
    return out
      .sort(
        (a, b) =>
          b.similarity - a.similarity ||
          effectiveConfidence(b.node, now) - effectiveConfidence(a.node, now) ||
          compareRecency(a.node, b.node),
      )
      .slice(0, CANDIDATE_POOL);
  }
}

/**
 * Backfill: embed every node that has no vector for this embedder's model.
 * Best-effort and resumable — safe to run at startup, returns how many were
 * indexed. Retired nodes are embedded too (the browser searches history).
 */
export async function indexMissingEmbeddings(
  store: MemoryStore,
  embedder: Embedder,
  batchSize = 32,
): Promise<number> {
  const existing = new Set((await store.listEmbeddings(embedder.model)).map((e) => e.nodeId));
  const all = await store.searchNodes({});
  const sealed = await store.searchNodes({
    privacyClassification: ["Sealed"],
  });
  const missing = [...all, ...sealed].filter((n) => !existing.has(n.nodeId));

  let indexed = 0;
  for (let i = 0; i < missing.length; i += batchSize) {
    const batch = missing.slice(i, i + batchSize);
    const vectors = await embedder.embed(batch.map((n) => n.content.text));
    for (let j = 0; j < batch.length; j += 1) {
      const vector = vectors[j];
      if (!vector) continue;
      await store.setEmbedding({
        nodeId: batch[j]!.nodeId,
        model: embedder.model,
        modelVersion: embedder.modelVersion,
        dimensions: embedder.dimensions,
        metric: "cosine",
        vector,
      });
      indexed += 1;
    }
  }
  return indexed;
}
