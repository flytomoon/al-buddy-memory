/**
 * The gauge: how big and how fast a real store is, against budgets.
 *
 * Why it exists (2026-09-26): on 2026-09-19 a benchmark measured that vectors
 * cost 8 KB each as JSON and that 95% of a cold semantic recall was reading and
 * parsing them, and the README named the fix. It was filed as a "weak spot" and
 * nothing happened for six days. A measurement with no budget is a fact nobody
 * owns. The gauge turns each measurement into a pass or a named breach, so a
 * host (a weekly job, CI) can raise a breach until someone decides.
 *
 * It only reads. Point it at a copy when the store is busy.
 */
import { statSync } from "node:fs";

import Database from "better-sqlite3";

import type { Embedder } from "./embedder.js";
import { HybridRetriever } from "./hybrid-retriever.js";
import { SqliteMemoryStore } from "./sqlite-memory-store.js";
import { currentStates } from "./state.js";

export interface GaugeResult {
  measuredAt: string;
  memories: number;
  liveMemories: number;
  /** The database file plus its WAL, on disk. */
  fileBytes: number;
  bytesPerMemory: number;
  vectors: number;
  vectorBytes: number;
  bytesPerVector: number | null;
  /** Vectors still stored as JSON text (0.8.1 stores float32 bytes). */
  jsonVectors: number;
  textBytes: number;
  historyRows: number;
  auditRows: number;
  /** Live memories with no vector: invisible to meaning search until indexed. */
  unindexedLive: number;
  currentStates: number;
  /** One recall with the vector cache cold — the first lookup of a turn. Null without an embedder. */
  coldRecallMs: number | null;
  /** Recall with the cache warm, median and 95th percentile over the query set. */
  warmRecallP50Ms: number | null;
  warmRecallP95Ms: number | null;
  /** Keyword-only recall (no embedder), median and 95th percentile. */
  keywordP50Ms: number;
  keywordP95Ms: number;
  /** Reading every current state, as each turn does. */
  statesMs: number;
}

export interface GaugeBudgets {
  bytesPerVector: number;
  bytesPerMemory: number;
  /** Cold recall allowance: a fixed part plus a part per 1,000 memories (the scan grows with the store). */
  coldRecallBaseMs: number;
  coldRecallPerThousandMs: number;
  warmRecallP95Ms: number;
  keywordP95Ms: number;
  statesMs: number;
  /** Share of live memories allowed to be unindexed at any moment. */
  unindexedShare: number;
  jsonVectors: number;
}

/**
 * Where the numbers should be. Set from the 0.8.1 measurements on a real
 * 6,819-vector store (1,536-byte vectors, ~150 ms cold, ~8 KB per memory with
 * history) with headroom — a breach means something got meaningfully worse.
 */
export const DEFAULT_BUDGETS: GaugeBudgets = {
  bytesPerVector: 1_700,
  bytesPerMemory: 12_000,
  coldRecallBaseMs: 150,
  coldRecallPerThousandMs: 25,
  warmRecallP95Ms: 120,
  keywordP95Ms: 150,
  statesMs: 150,
  unindexedShare: 0.02,
  jsonVectors: 0,
};

export interface Breach {
  metric: keyof GaugeResult;
  value: number;
  budget: number;
  /** One plain sentence: what it costs and what fixing it would give. */
  why: string;
}

const pct = (xs: number[], p: number): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))]! : 0;
};
const round = (n: number): number => Math.round(n * 10) / 10;

/**
 * Measure a store file. `queries` defaults to texts sampled from the store
 * itself, so the lookups look like real ones.
 */
export async function gaugeStore(path: string, opts: { embedder?: Embedder; queries?: string[]; now?: () => Date } = {}): Promise<GaugeResult> {
  const raw = new Database(path, { readonly: true, fileMustExist: true });
  const one = <T>(sql: string): T => raw.prepare(sql).get() as T;
  const count = (sql: string): number => (one<{ n: number | null }>(sql).n ?? 0);
  const now = (opts.now ?? (() => new Date()))().toISOString();
  const memories = count("SELECT count(*) AS n FROM memory_nodes");
  const liveMemories = count(`SELECT count(*) AS n FROM memory_nodes WHERE valid_to IS NULL OR valid_to > '${now}'`);
  const vectors = count("SELECT count(*) AS n FROM memory_embeddings");
  const vectorBytes = count("SELECT sum(length(vector)) AS n FROM memory_embeddings");
  const jsonVectors = count("SELECT count(*) AS n FROM memory_embeddings WHERE typeof(vector) = 'text'");
  const textBytes = count("SELECT sum(length(content_text)) AS n FROM memory_nodes");
  const has = (table: string): boolean => one<{ n: number }>(`SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='${table}'`).n > 0;
  const historyRows = has("node_versions") ? count("SELECT count(*) AS n FROM node_versions") : 0;
  const auditRows = has("audit_events") ? count("SELECT count(*) AS n FROM audit_events") : 0;
  const unindexedLive = count(
    `SELECT count(*) AS n FROM memory_nodes n WHERE (valid_to IS NULL OR valid_to > '${now}') AND NOT EXISTS (SELECT 1 FROM memory_embeddings e WHERE e.node_id = n.node_id)`,
  );
  const sample = (raw.prepare("SELECT content_text AS t FROM memory_nodes WHERE length(content_text) BETWEEN 20 AND 400 ORDER BY node_id LIMIT 400").all() as { t: string }[])
    .filter((_, i) => i % 20 === 0)
    .map((r) => r.t.split(/\s+/).slice(0, 8).join(" "));
  raw.close();
  let fileBytes = statSync(path).size;
  try {
    fileBytes += statSync(`${path}-wal`).size;
  } catch {
    /* no WAL beside it */
  }
  const queries = (opts.queries ?? sample).slice(0, 20);

  const store = new SqliteMemoryStore(path);
  try {
    const keyword = new HybridRetriever(store);
    const kTimes: number[] = [];
    for (const q of queries) {
      const t = performance.now();
      await keyword.recall(q, { limit: 10 });
      kTimes.push(performance.now() - t);
    }
    let coldRecallMs: number | null = null;
    let warmRecallP50Ms: number | null = null;
    let warmRecallP95Ms: number | null = null;
    if (opts.embedder && queries.length > 0) {
      // Load the model outside the timing: its cost is the embedder's, not the store's.
      await opts.embedder.embed(["warm up"]);
      const cold = new HybridRetriever(store, opts.embedder, { cacheTtlMs: 0 });
      const t = performance.now();
      await cold.recall(queries[0]!, { limit: 10 });
      coldRecallMs = round(performance.now() - t);
      const warm = new HybridRetriever(store, opts.embedder, { cacheTtlMs: 60_000 });
      await warm.recall(queries[0]!, { limit: 10 });
      const wTimes: number[] = [];
      for (const q of queries) {
        const t2 = performance.now();
        await warm.recall(q, { limit: 10 });
        wTimes.push(performance.now() - t2);
      }
      warmRecallP50Ms = round(pct(wTimes, 0.5));
      warmRecallP95Ms = round(pct(wTimes, 0.95));
    }
    const ts = performance.now();
    const states = await currentStates(store);
    const statesMs = round(performance.now() - ts);
    return {
      measuredAt: now,
      memories,
      liveMemories,
      fileBytes,
      bytesPerMemory: memories ? Math.round(fileBytes / memories) : 0,
      vectors,
      vectorBytes,
      bytesPerVector: vectors ? Math.round(vectorBytes / vectors) : null,
      jsonVectors,
      textBytes,
      historyRows,
      auditRows,
      unindexedLive,
      currentStates: states.length,
      coldRecallMs,
      warmRecallP50Ms,
      warmRecallP95Ms,
      keywordP50Ms: round(pct(kTimes, 0.5)),
      keywordP95Ms: round(pct(kTimes, 0.95)),
      statesMs,
    };
  } finally {
    store.close();
  }
}

/** Every budget the measurement misses, each with the reason it matters. */
export function checkBudgets(g: GaugeResult, b: GaugeBudgets = DEFAULT_BUDGETS): Breach[] {
  const out: Breach[] = [];
  const add = (metric: keyof GaugeResult, value: number | null, budget: number, why: string): void => {
    if (value !== null && value > budget) out.push({ metric, value, budget: Math.round(budget), why });
  };
  add("bytesPerVector", g.bytesPerVector, b.bytesPerVector, "Each vector costs more disk than it should, and every cold lookup reads them all.");
  add("jsonVectors", g.jsonVectors, b.jsonVectors, "Vectors still stored as JSON text are ~5x larger and must be parsed on every cold lookup.");
  add("bytesPerMemory", g.bytesPerMemory, b.bytesPerMemory, "The file is growing faster per memory than it should; backups and lookups grow with it.");
  add("coldRecallMs", g.coldRecallMs, b.coldRecallBaseMs + (b.coldRecallPerThousandMs * g.liveMemories) / 1000, "The first memory lookup of a turn is slower than it should be for this many memories.");
  add("warmRecallP95Ms", g.warmRecallP95Ms, b.warmRecallP95Ms, "Repeated lookups are slow even with the index loaded.");
  add("keywordP95Ms", g.keywordP95Ms, b.keywordP95Ms, "Keyword search is slow.");
  add("statesMs", g.statesMs, b.statesMs, "Reading where things stand, done every turn, is slow.");
  add("unindexedLive", g.unindexedLive, b.unindexedShare * Math.max(1, g.liveMemories), "Memories that meaning search cannot find yet.");
  return out;
}
