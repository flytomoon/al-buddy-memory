/**
 * The no-loss gate (founder, 2026-09-26: "optimization is fine, but loss is
 * not fine"). Before a change to how memory is stored or searched ships, run
 * it on a COPY of a real store and compare the copy with the original:
 *
 *   - content: every memory and every edge, exported in the portable format,
 *     must be identical — same text, same metadata, same validity, same history
 *     anchors;
 *   - recall: the top results for a set of real lookups must be the same
 *     memories in the same order.
 *
 * This is what was done by hand for float32 vectors in 0.8.1 (20 of 20
 * lookups identical); it is now one call.
 */
import type { Embedder } from "./embedder.js";
import { HybridRetriever } from "./hybrid-retriever.js";
import { exportPortable } from "./memory-portability.js";
import { SqliteMemoryStore } from "./sqlite-memory-store.js";

export interface NoLossReport {
  /** True only when content and every compared lookup match. */
  lossless: boolean;
  contentIdentical: boolean;
  /** The first few content differences, by memory id. */
  contentDiffs: string[];
  lookups: number;
  lookupsIdentical: number;
  /** Queries whose results differ, with both result lists. */
  lookupDiffs: { query: string; before: string[]; after: string[] }[];
}

async function portableOf(path: string): Promise<{ nodes: Map<string, string>; edges: string; versions: string }> {
  const store = new SqliteMemoryStore(path);
  try {
    const out = await exportPortable(new Map([["p", store]]));
    const project = out.projects[0];
    const nodes = new Map<string, string>();
    for (const n of (project?.nodes ?? []) as { nodeId: string }[]) nodes.set(n.nodeId, JSON.stringify(n));
    const edges = JSON.stringify(((project?.edges ?? []) as { edgeId: string }[]).map((e) => JSON.stringify(e)).sort());
    const versions = JSON.stringify(((project?.versions ?? []) as unknown[]).map((v) => JSON.stringify(v)).sort());
    return { nodes, edges, versions };
  } finally {
    store.close();
  }
}

async function lookups(path: string, queries: readonly string[], embedder?: Embedder): Promise<string[][]> {
  const store = new SqliteMemoryStore(path);
  try {
    const r = new HybridRetriever(store, embedder, { cacheTtlMs: 0 });
    const out: string[][] = [];
    for (const q of queries) out.push((await r.recall(q, { limit: 10 })).map((n) => n.nodeId));
    return out;
  } finally {
    store.close();
  }
}

export async function compareStores(beforePath: string, afterPath: string, opts: { queries: readonly string[]; embedder?: Embedder }): Promise<NoLossReport> {
  const [a, b] = [await portableOf(beforePath), await portableOf(afterPath)];
  const contentDiffs: string[] = [];
  for (const [id, text] of a.nodes) if (b.nodes.get(id) !== text) contentDiffs.push(b.nodes.has(id) ? `changed ${id}` : `missing ${id}`);
  for (const id of b.nodes.keys()) if (!a.nodes.has(id)) contentDiffs.push(`added ${id}`);
  if (a.edges !== b.edges) contentDiffs.push("edges differ");
  if (a.versions !== b.versions) contentDiffs.push("history differs");
  const [ra, rb] = [await lookups(beforePath, opts.queries, opts.embedder), await lookups(afterPath, opts.queries, opts.embedder)];
  const lookupDiffs = opts.queries.flatMap((query, i) => (JSON.stringify(ra[i]) === JSON.stringify(rb[i]) ? [] : [{ query, before: ra[i]!, after: rb[i]! }]));
  const contentIdentical = contentDiffs.length === 0;
  return {
    lossless: contentIdentical && lookupDiffs.length === 0,
    contentIdentical,
    contentDiffs: contentDiffs.slice(0, 20),
    lookups: opts.queries.length,
    lookupsIdentical: opts.queries.length - lookupDiffs.length,
    lookupDiffs: lookupDiffs.slice(0, 10),
  };
}
