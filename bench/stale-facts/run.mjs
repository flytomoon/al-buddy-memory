#!/usr/bin/env node
// Usage: npm run build && node bench/stale-facts/run.mjs [--k 5] [--embedder local] [--out path.json]
//
// The stale-fact benchmark (see stale-facts.mjs): the same changing facts into
// the same store three ways — append-only, append-only recalled with
// freshness, and recordState — and the same questions asked of each. No model
// is called unless --embedder local is given (the on-device embedder). Writes
// bench/results/<date>-stale-facts.json.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { RESULTS_DIR, REPO_ROOT, isoDate, resultPath, runInfo, writeJson } from "../lib/run-info.mjs";
import { STRATEGIES, loadCases, runStrategy, summarizeStrategy } from "./stale-facts.mjs";

const { values: args } = parseArgs({ options: { k: { type: "string", default: "5" }, embedder: { type: "string", default: "none" }, out: { type: "string" } } });
const k = Number(args.k);
if (!Number.isInteger(k) || k < 1) throw new Error(`--k must be a positive integer (got ${args.k})`);
if (!["none", "local"].includes(args.embedder)) throw new Error(`--embedder must be none or local (got ${args.embedder})`);

const distEntry = join(REPO_ROOT, "dist", "index.js");
if (!existsSync(distEntry)) throw new Error("dist/ is missing: run `npm run build` first (the benchmark measures the built package).");
const lib = await import(pathToFileURL(distEntry).href);
const casesPath = join(REPO_ROOT, "bench", "stale-facts", "cases.json");
const cases = loadCases(casesPath);
const embedder = args.embedder === "local" ? new lib.LocalEmbedder() : undefined;

const info = runInfo();
const byStrategy = {};
const rows = {};
for (const strategy of STRATEGIES) {
  rows[strategy] = await runStrategy(lib, cases, strategy, { k, embedder });
  byStrategy[strategy] = summarizeStrategy(rows[strategy]);
}

const out = args.out ?? resultPath(RESULTS_DIR, isoDate(), "stale-facts");
writeJson(out, {
  benchmark: "stale-facts",
  date: new Date().toISOString(),
  ...info,
  dataset: { file: "bench/stale-facts/cases.json", version: cases.version, subjects: cases.subjects.length, statements: cases.subjects.reduce((n, s) => n + s.statements.length, 0), distractors: cases.distractors.length, now: cases.now },
  settings: {
    k,
    retrieval: embedder ? "hybrid" : "keyword",
    embedder: embedder ? { model: embedder.model, modelVersion: embedder.modelVersion, dimensions: embedder.dimensions } : null,
    store: "SqliteMemoryStore(':memory:'), a fresh one per strategy",
    recall: "HybridRetriever.recall(question, { limit: k, validAt }); validAt is the dataset's `now`, or the instant an as-of question names",
    strategies: {
      "append-only": "every statement an ordinary fact (addNode, validFrom = its date); nothing is closed",
      "append-only+freshness": "the same store, recalled with freshness: 1",
      "current-state": "every statement through recordState(subject, aspect, text, at); a newer state closes the one it replaces",
    },
    caveats: [
      "The subject and aspect of each statement come from the dataset; a host model would have to choose them.",
      "As-of questions are given their instant; a host model would have to read it from the question.",
      "It compares the library with itself, with and without invalidation — not with any other system.",
    ],
  },
  metrics: {
    currentAt1: "the first result is the statement true at the instant asked",
    staleAt1: "the first result is another statement of the same subject (the reader would most likely repeat it)",
    currentInTopK: "the true statement is among the first k",
    staleInTopK: "another statement of the same subject is among the first k",
    cleanTopK: "the true statement is among the first k and no other statement of its subject is",
  },
  summary: byStrategy,
  questions: rows,
});

const pct = (x) => `${(x * 100).toFixed(1)}%`.padStart(7);
console.log(`Wrote ${out}\n`);
console.log(`${"strategy".padEnd(24)} ${"questions".padEnd(12)} current@1  stale@1  current@${k}  stale@${k}  clean@${k}`);
for (const strategy of STRATEGIES) {
  for (const [slice, r] of Object.entries(byStrategy[strategy])) {
    if (!r.n) continue;
    console.log(`${strategy.padEnd(24)} ${`${slice} (${r.n})`.padEnd(12)} ${pct(r.currentAt1)}  ${pct(r.staleAt1)}  ${pct(r.currentInTopK)}   ${pct(r.staleInTopK)}  ${pct(r.cleanTopK)}`);
  }
}
