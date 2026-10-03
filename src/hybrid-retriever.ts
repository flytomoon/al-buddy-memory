import { compareBinary, compareRecency, effectiveConfidence } from "./decay.js";
import { canonicalInstant } from "./instant.js";
import type { EmbeddingVector, MemoryNode, MemoryStore, MemoryEmbedding } from "./types/memory.js";
import { PRIVACY_CLASSIFICATIONS, RETENTION_TIERS } from "./types/memory.js";
import type { Embedder } from "./embedder.js";
import { cosineSimilarity } from "./embedder.js";
import { matchesFilter, MAX_QUERY_TOKENS, type NodeFilter } from "./query-filter.js";
import { analyzeQuery, inWindows, keywordsOf, type QueryCues } from "./query-cues.js";
import { rerankTexts, type Reranker } from "./reranker.js";

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
  /**
   * How much being recently learned counts, as a third ranked list fused with
   * the keyword and vector lists (0 = off, the default; 1 = as much as either
   * of them). Only facts the query already matched are reordered — freshness
   * never brings in a fact on its own. For "where do things stand" questions,
   * where the newest of several matching notes is usually the true one.
   */
  freshness?: number;
  /**
   * Read the query for time and counting cues (`analyzeQuery`) and recall
   * accordingly. Off by default; recall without it is unchanged. With it,
   * the query is searched as it always is, and besides:
   *
   * - A query longer than the keyword search reads (sixteen words) is also
   *   searched by its content words, so the end of a long question counts.
   * - A query naming a period ("in April", "the past two weeks", "last
   *   Thursday") is also searched without those words, and facts valid from a
   *   time inside the period (their `validFrom`) are favoured as one more
   *   fused list. Facts from outside it are never dropped.
   * - A question that counts, totals or compares across memories ("how many",
   *   "total", "A and B") searches each thing it names as well as the whole,
   *   from twice the usual candidate pool.
   * - "Currently", "latest", "so far" favour the facts valid from the latest
   *   time; "first", "initially" the earliest. Half a list's weight.
   *
   * `true` resolves relative dates against `validAt` (default now); pass
   * `{ now }` to ask as of another moment without changing what is valid.
   * Cost: one keyword search and one vector scan per query it reads out of
   * this one — at most eight, usually one or two.
   */
  expand?: boolean | { now?: string };
  /** With a `reranker` configured on the retriever, `false` skips it for this recall. */
  rerank?: boolean;
  /**
   * How many candidates each keyword and vector list contributes before they
   * are fused (default 50; `expand` doubles it for a question that counts).
   * More gives a reranker more to choose from, at the cost of reading more.
   */
  candidates?: number;
}

export interface HybridRetrieverOptions {
  /** How long the vector matrix is held between recalls (default 60 s). */
  cacheTtlMs?: number;
  now?: () => number;
  /**
   * A cross-encoder that reorders the fused candidates (see `reranker.ts`).
   * Without one, recall is keyword and vector fusion alone.
   */
  reranker?: Reranker;
  /** How many fused candidates the reranker reads: default the larger of the limit and 50. */
  rerankDepth?: number;
}

const CANDIDATE_POOL = 50;
/** How much deeper each list reads when `expand` finds a question that counts across memories. */
const EXPANDED_POOL_FACTOR = 2;
const RRF_K = 60; // standard reciprocal-rank-fusion constant
/** Cosine similarity above which two texts state the same fact. */
const DUPLICATE_THRESHOLD = 0.9;
/** Confidence bump when a duplicate observation reinforces a node. */
const REINFORCE_STEP = 0.05;
const RERANK_DEPTH = 50;
/** A reranked order stands for the keyword and vector lists it replaces, so it counts as two lists. */
const RERANKED_WEIGHT = 2;
/** `expand`: the in-period list counts as one list; the earliest/latest list as half of one. */
const WINDOW_WEIGHT = 1;
const ORDER_WEIGHT = 0.5;

/** Newest `validFrom` first; then the store's own recency order. */
function compareValidFrom(a: MemoryNode, b: MemoryNode): number {
  const x = Date.parse(a.validFrom), y = Date.parse(b.validFrom);
  return (Number.isFinite(x) && Number.isFinite(y) ? y - x : 0) || compareRecency(a, b);
}

export class HybridRetriever {
  /**
   * The vector matrix, held for a moment. Every recall used to JSON-parse
   * every stored vector, and the curator + reconciler recall once per fact,
   * so one chatty message parsed the whole store ~8× (review 2026-09-01,
   * idea 6). A short TTL covers that burst; another process writing
   * embeddings is seen within the TTL, and this retriever's own writes
   * clear it at once.
   */
  private vectorCache: { model: string; at: number; rows: EmbeddingVector[] } | null = null;

  constructor(
    private readonly store: MemoryStore,
    private readonly embedder?: Embedder,
    private readonly opts: HybridRetrieverOptions = {},
  ) {
    const depth = opts.rerankDepth;
    if (depth !== undefined && (!Number.isInteger(depth) || depth < 1)) throw new Error(`HybridRetriever: rerankDepth must be an integer >= 1 (got ${depth})`);
  }

  private async embeddingsFor(model: string): Promise<EmbeddingVector[]> {
    const now = (this.opts.now ?? Date.now)();
    const ttl = this.opts.cacheTtlMs ?? 60_000;
    const c = this.vectorCache;
    if (c && c.model === model && now - c.at < ttl) return c.rows;
    // Views when the store offers them (0.8.3): building an array per vector
    // was most of a cold lookup; the numbers, and so the results, are the same.
    const rows: EmbeddingVector[] = this.store.listEmbeddingVectors
      ? await this.store.listEmbeddingVectors(model)
      : await this.store.listEmbeddings(model);
    this.vectorCache = { model, at: now, rows };
    return rows;
  }

  async recall(query: string, options: RecallOptions = {}): Promise<MemoryNode[]> {
    const limit = options.limit ?? 5;
    const freshness = options.freshness ?? 0;
    if (!Number.isFinite(freshness) || freshness < 0) throw new Error(`recall: freshness must be a finite number >= 0 (got ${options.freshness})`);
    const validAt = options.validAt === undefined ? new Date().toISOString() : canonicalInstant(options.validAt, "validAt");

    // Scope (type, tags, confidence, privacy / retention tiers) applies to BOTH
    // lists, with the store's own semantics, so a scoped recall can never pull
    // an out-of-scope fact in through the vector side.
    const { limit: _limit, validAt: _validAt, freshness: _freshness, expand: _expand, rerank: _rerank, candidates: _candidates, ...scope } = options;
    const filter: NodeFilter = { ...scope, validAt };
    const basePool = options.candidates ?? CANDIDATE_POOL;
    if (!Number.isInteger(basePool) || basePool < 1) throw new Error(`recall: candidates must be an integer >= 1 (got ${options.candidates})`);
    const cues = options.expand ? analyzeQuery(query, { now: (typeof options.expand === "object" ? options.expand.now : undefined) ?? validAt }) : null;

    // Reciprocal-rank fusion across every list.
    let scores = new Map<string, { score: number; node: MemoryNode }>();
    const addList = (nodes: MemoryNode[], weight = 1) => {
      nodes.forEach((node, index) => {
        const entry = scores.get(node.nodeId) ?? { score: 0, node };
        entry.score += weight / (RRF_K + index + 1);
        scores.set(node.nodeId, entry);
      });
    };

    // How many lists the relevance side weighs, all told. The time lists below
    // are sized against two — the keyword and the vector list of one query —
    // so a time cue counts the same however many queries `expand` ran, and
    // whether or not a reranker replaced them. Without `expand` it is two.
    let relevanceWeight = 2;

    if (!cues) {
      // Keyword list — BM25-ordered by the store.
      addList(await this.store.searchNodes({ ...filter, query, limit: basePool }));
      // Vector list — full scan of the embedder's model space (local scale).
      addList((await this.vectorCandidates(query, filter, basePool)).map((v) => v.node));
    } else {
      // The same two lists for every query `expand` reads out of this one.
      const pool = cues.aggregation ? EXPANDED_POOL_FACTOR * basePool : basePool;
      const queries = expandedQueries(query, cues);
      const vectors = this.embedder ? await this.embedder.embed(queries) : [];
      let lists = 0;
      const addRelevance = (nodes: MemoryNode[]) => {
        if (nodes.length > 0) lists += 1;
        addList(nodes);
      };
      for (const [i, q] of queries.entries()) {
        // The query itself is searched exactly as recall without `expand` searches
        // it, so expanding can only add to what plain recall finds; what it reads
        // out of the query is searched by content words alone.
        addRelevance(await this.store.searchNodes({ ...filter, query: i === 0 ? q : keywordsOf(q), limit: pool }));
        const vector = vectors[i];
        if (vector) addRelevance((await this.vectorCandidatesFor(vector, filter, pool)).map((v) => v.node));
      }
      // A question longer than the keyword search reads is searched once more by
      // its content words, so the things it names last are searched at all.
      const long = (query.match(/[\p{L}\p{N}]+/gu) ?? []).length > MAX_QUERY_TOKENS;
      if (long && keywordsOf(query)) addRelevance(await this.store.searchNodes({ ...filter, query: keywordsOf(query), limit: pool }));
      relevanceWeight = Math.max(1, lists);
    }

    // A cross-encoder reads the question with each of the best candidates and
    // puts them in its order; that order then stands in for the lists it read.
    if (this.opts.reranker && options.rerank !== false && scores.size > 0) {
      const ranked = rankFused(scores);
      const depth = this.opts.rerankDepth ?? Math.max(limit, RERANK_DEPTH);
      const head = ranked.slice(0, depth);
      const order = await rerankTexts(this.opts.reranker, query, head.map((e) => e.node.content.text));
      scores = new Map(
        [...order.map((o) => head[o.index]!), ...ranked.slice(depth)].map((e, i) => [e.node.nodeId, { node: e.node, score: RERANKED_WEIGHT / (RRF_K + i + 1) }]),
      );
      relevanceWeight = RERANKED_WEIGHT;
    }
    const timeScale = relevanceWeight / 2;

    // Recency as a third list over the facts already matched, weighted.
    if (freshness > 0) {
      [...scores.values()]
        .map((e) => e.node)
        .sort(compareRecency)
        .forEach((node, index) => {
          scores.get(node.nodeId)!.score += (freshness * timeScale) / (RRF_K + index + 1);
        });
    }

    // `expand`'s time lists, over the facts already matched, in their order so far.
    if (cues && (cues.windows.length > 0 || cues.order)) {
      const relevance = rankFused(scores).map((e) => e.node);
      if (cues.windows.length > 0) addList(relevance.filter((n) => inWindows(n.validFrom, cues.windows)), WINDOW_WEIGHT * timeScale);
      if (cues.order === "latest") addList([...relevance].sort(compareValidFrom), ORDER_WEIGHT * timeScale);
      if (cues.order === "earliest") addList([...relevance].sort((a, b) => compareValidFrom(b, a)), ORDER_WEIGHT * timeScale);
    }

    return rankFused(scores)
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
    pool = CANDIDATE_POOL,
  ): Promise<{ node: MemoryNode; similarity: number }[]> {
    if (!this.embedder) return [];
    const [queryVector] = await this.embedder.embed([query]);
    if (!queryVector) return [];
    return this.vectorCandidatesFor(queryVector, filter, pool);
  }

  private async vectorCandidatesFor(
    queryVector: number[],
    filter: NodeFilter,
    pool: number,
  ): Promise<{ node: MemoryNode; similarity: number }[]> {
    if (!this.embedder) return [];
    const embeddings = await this.embeddingsFor(this.embedder.model);

    // A vector from another version of this model is from another SPACE: its
    // cosine against this query means nothing, even when the dimensions match.
    // The length check alone let a provider that shipped new weights under the
    // same name go on answering out of the old space, silently (Astra R9); the
    // length check stays because a shorter vector scores NaN, and NaN made the
    // sort non-transitive, so the winner depended on insertion order. Skip
    // both; backfill replaces them.
    const version = this.embedder.modelVersion;
    const dimensions = this.embedder.dimensions;
    const scored = embeddings
      .filter((e) => e.modelVersion === version && e.dimensions === dimensions && e.vector.length === queryVector.length)
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
      if (out.length >= pool && similarity < out[out.length - 1]!.similarity) break;
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
      .slice(0, pool);
  }
}

/**
 * The same order as the stores: fused rank, then EFFECTIVE confidence (it
 * compared stored confidence, so a fact decayed to half its weight still won
 * the tie), then the most recently learned. A fused tie is the ordinary
 * shape of reciprocal-rank fusion: one fact wins the keyword list, the other
 * the vector list, and 1/61 + 1/62 is the same number both ways.
 */
function rankFused(scores: Map<string, { score: number; node: MemoryNode }>): { score: number; node: MemoryNode }[] {
  const now = Date.now();
  return [...scores.values()]
    .map((e) => ({ ...e, eff: effectiveConfidence(e.node, now) }))
    .sort((a, b) => b.score - a.score || b.eff - a.eff || compareRecency(a.node, b.node));
}

/**
 * The queries `expand` recalls with, each once: the query itself; without its
 * time words, when it has some; and, for a question that counts across
 * memories, each thing it names. A derived query with nothing left to search
 * for ("What did I do last weekend?" without its period is "What did I do?")
 * is dropped: it would match every memory that says "I".
 */
export function expandedQueries(query: string, cues: QueryCues): string[] {
  const derived = [...(cues.withoutTime ? [cues.withoutTime] : []), ...(cues.aggregation ? cues.parts : [])].filter((q) => keywordsOf(q) !== "");
  const seen = new Set<string>();
  return [query, ...derived].filter((q) => {
    const key = keywordsOf(q) || q.trim().toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Backfill: embed every node whose vector is missing OR was made by a different
 * version of this model. Best-effort and resumable — safe to run at startup,
 * returns how many were indexed. Every node is embedded — retired, Archived,
 * PendingDeletion and Sealed included (the browser searches history, and a scoped
 * recall may name any tier).
 *
 * "Missing" used to mean "no row for this model NAME", so an upgrade that kept
 * the name reported nothing to do and left every vector in the old space
 * (Astra R9, 2026-09-18). A row for the same (nodeId, model) is replaced by
 * setEmbedding, so the stale one does not survive the pass.
 *
 * `limit` bounds one pass (default: no bound): a server indexing in the
 * background at start embeds at most that many and leaves the rest for the
 * next start, so a large backlog never holds a CPU for minutes at a time.
 *
 * It shares the event loop with whatever else the process serves, so it gives
 * the loop back between batches and after every `sliceMs` (default 20 ms) of
 * writes: a server indexing 5,000 facts after start kept answering /health in
 * 85 ms at p95 before this, 268 ms at worst (founder's Mac: seconds). An
 * embedder that computes on this thread (LocalEmbedder) still blocks for one
 * whole batch, so pass a small `batchSize` with it — or use WorkerEmbedder,
 * which computes off the loop.
 */
export async function indexMissingEmbeddings(
  store: MemoryStore,
  embedder: Embedder,
  batchSize = 32,
  options: { limit?: number; sliceMs?: number } = {},
): Promise<number> {
  const limit = options.limit ?? Infinity;
  const sliceMs = options.sliceMs ?? 20;
  if (!(limit >= 0)) throw new Error(`indexMissingEmbeddings: limit must be >= 0 (got ${options.limit})`);
  const existing = new Set(
    (await store.listEmbeddings(embedder.model))
      .filter((e) => e.modelVersion === embedder.modelVersion && e.dimensions === embedder.dimensions)
      .map((e) => e.nodeId),
  );
  // Every tier and classification by name: `{}` alone hides Archived and
  // PendingDeletion, so a scoped recall that names them had no vectors to find
  // (review 2026-09-22). What a recall may SEE is still decided at read time.
  const missing = (await store.searchNodes({ retentionTier: [...RETENTION_TIERS], privacyClassification: [...PRIVACY_CLASSIFICATIONS] }))
    .filter((n) => !existing.has(n.nodeId))
    .slice(0, limit === Infinity ? undefined : Math.floor(limit));

  let indexed = 0;
  let slice = performance.now();
  const giveBack = async (always = false) => {
    if (!always && performance.now() - slice < sliceMs) return;
    await yieldToLoop();
    slice = performance.now();
  };
  await giveBack(true); // the two reads above are one slice
  for (let i = 0; i < missing.length; i += batchSize) {
    const batch = missing.slice(i, i + batchSize);
    const vectors = await embedder.embed(batch.map((n) => n.content.text));
    await giveBack(true);
    for (let j = 0; j < batch.length; j += 1) {
      await giveBack();
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

/** Let timers, I/O and queued requests run: a macrotask, not a microtask. */
function yieldToLoop(): Promise<void> {
  return new Promise((resolve) => (typeof setImmediate === "function" ? setImmediate(resolve) : setTimeout(resolve, 0)));
}
