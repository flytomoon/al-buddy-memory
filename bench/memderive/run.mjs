#!/usr/bin/env node
// Usage: npm run build && node bench/memderive/run.mjs [--filler 1500] [--embedder local|none]
//          [--data bench/longmemeval/data/longmemeval_s_cleaned.json] [--seed 1] [--k 10] [--out path.json]
//
// Derived state over evolving data (see memderive.mjs): the same events,
// distractors and LongMemEval filler into one store and one BM25 index, every
// question asked of al-buddy-memory's recall and of BM25. Retrieval only: no
// model reads or answers anything; --embedder local runs the on-device
// embedder. Writes bench/results/<date>-memderive.json. The last line printed
// is "RESULT: …".
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { RESULTS_DIR, REPO_ROOT, isoDate, resultPath, runInfo, writeJson } from "../lib/run-info.mjs";
import { KS, SYSTEMS, buildStore, compare, fillerFrom, itemsOf, loadCases, makeRankers, questionsOf, runQuestions, summarize } from "./memderive.mjs";

const fail = (message) => {
  console.error(message);
  console.log(`RESULT: the derived-state benchmark did not run: ${message}`);
  process.exit(1);
};

const { values: args } = parseArgs({
  options: {
    filler: { type: "string", default: "1500" },
    embedder: { type: "string", default: "local" },
    data: { type: "string", default: join(REPO_ROOT, "bench", "longmemeval", "data", "longmemeval_s_cleaned.json") },
    seed: { type: "string", default: "1" },
    k: { type: "string", default: "10" },
    out: { type: "string" },
  },
});
const fillerCount = Number(args.filler);
const seed = Number(args.seed);
const k = Number(args.k);
if (!Number.isInteger(fillerCount) || fillerCount < 0) fail(`--filler must be an integer >= 0 (got ${args.filler})`);
if (!Number.isInteger(seed)) fail(`--seed must be an integer (got ${args.seed})`);
if (!KS.includes(k)) fail(`--k must be one of ${KS.join(", ")} (got ${args.k})`);
if (!["none", "local"].includes(args.embedder)) fail(`--embedder must be none or local (got ${args.embedder})`);

const distEntry = join(REPO_ROOT, "dist", "index.js");
if (!existsSync(distEntry)) fail("dist/ is missing: run `npm run build` first (the benchmark measures the built package)");
const lib = await import(pathToFileURL(distEntry).href);
let cases;
try {
  cases = loadCases(join(REPO_ROOT, "bench", "memderive", "cases.json"));
} catch (err) {
  fail(`bench/memderive/cases.json: ${err instanceof Error ? err.message : String(err)}`);
}
const items = itemsOf(cases);
const questions = questionsOf(cases);

// Filler: real user turns, dated across the year the events span.
let filler = [];
let fillerSource = null;
if (fillerCount > 0) {
  const dataPath = resolve(args.data);
  if (!existsSync(dataPath)) fail(`--filler ${fillerCount} needs the LongMemEval_S file at ${dataPath} (node bench/longmemeval/download.mjs), or pass --filler 0`);
  try {
    const raw = readFileSync(dataPath);
    const sha256 = createHash("sha256").update(raw).digest("hex");
    const pin = JSON.parse(readFileSync(join(REPO_ROOT, "bench", "longmemeval", "dataset.json"), "utf8")).files.s.sha256;
    const instances = JSON.parse(raw.toString("utf8"));
    const from = items[0].at;
    const to = cases.now;
    filler = fillerFrom(instances, { count: fillerCount, seed, from, to });
    fillerSource = { file: "LongMemEval_S (cleaned), user turns from every haystack", sha256, matchesPin: sha256 === pin, seed, from, to, count: filler.length };
  } catch (err) {
    fail(`reading filler from ${dataPath}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
const all = [...items, ...filler];

const info = runInfo();
const embedder = args.embedder === "local" ? new lib.LocalEmbedder() : undefined;
console.log(`Storing ${items.length} events and distractors and ${filler.length} filler turns${embedder ? ", embedding them on-device" : ""}…`);
const started = Date.now();
let store;
try {
  store = await buildStore(lib, all, { embedder });
} catch (err) {
  fail(`building the store failed: ${err instanceof Error ? err.message : String(err)}`);
}
const buildSeconds = Math.round((Date.now() - started) / 100) / 10;

let run;
let skipped;
try {
  const made = makeRankers(lib, store, all, { now: cases.now, embedder });
  skipped = made.skipped;
  for (const [system, why] of Object.entries(skipped)) console.log(`skipped ${system}: ${why}`);
  run = await runQuestions(questions, made.rankers, { log: (line) => console.error(`FAILED ${line}`) });
} catch (err) {
  store.close();
  fail(`setting up recall failed: ${err instanceof Error ? err.message : String(err)}`);
} finally {
  store.close();
}
const systems = SYSTEMS.filter((s) => !(s in skipped));
console.log(`attempted ${run.attempted} recalls, succeeded ${run.succeeded}, failed ${run.failed}${run.aborted ? `; ${run.aborted}` : ""}`);
if (run.succeeded === 0) fail(`no recall succeeded (${run.attempted} attempted)${run.aborted ? `; ${run.aborted}` : ""}`);

const summary = summarize(run.rows, systems);
const ours = embedder ? "al-buddy" : "al-buddy-keyword";
const comparisons = ["bm25", "bm25-stem"].map((b) => compare(run.rows, ours, b, k));

const out = args.out ?? resultPath(RESULTS_DIR, isoDate(), "memderive");
writeJson(out, {
  benchmark: "memderive-derived-state",
  date: new Date().toISOString(),
  ...info,
  complete: run.aborted === null && run.failed === 0,
  aborted: run.aborted,
  counts: { attempted: run.attempted, succeeded: run.succeeded, failed: run.failed },
  dataset: {
    file: "bench/memderive/cases.json",
    version: cases.version,
    subjects: cases.subjects.length,
    events: items.filter((i) => i.kind === "event").length,
    distractors: items.filter((i) => i.kind === "distractor").length,
    questions: questions.length,
    now: cases.now,
    filler: fillerSource,
  },
  settings: {
    ks: KS,
    headlineK: k,
    embedder: embedder ? { model: embedder.model, modelVersion: embedder.modelVersion, dimensions: embedder.dimensions } : null,
    store: "SqliteMemoryStore(':memory:'), every item a plain fact (validFrom = when it was said), told in date order",
    buildSeconds,
    systems: {
      "al-buddy": "HybridRetriever(store, LocalEmbedder).recall(q, { limit: 20, validAt: now, expand: true }), as the MCP recall tool runs it",
      "al-buddy-keyword": "HybridRetriever(store).recall(q, { limit: 20, validAt: now, expand: true }): no embedder",
      fts: "store.searchNodes({ query: q, limit: 20, validAt: now }): FTS5 bm25 over the first 16 words, OR-ed",
      bm25: "Okapi BM25, k1 1.2, b 0.75, unicode61-style words, no stemming, no stopwords",
      "bm25-stem": "the same, with Lucene English stopwords, possessives dropped and Porter stemming (Pyserini's default analyzer)",
    },
    skipped,
    caveats: [
      "Not the MemDerive dataset: the paper and its code could not be read where this was written. The questions are ours.",
      "Retrieval only: a question counts as answerable when every event it needs is in the first k. No model read or answered anything.",
      "The needed events are the whole history of what the question asks about, so a reader shown them can always derive the answer; some answers could be derived from fewer.",
      `${questions.length} questions: one question is ${(100 / questions.length).toFixed(1)} points, so a difference of one or two questions is noise.`,
    ],
  },
  metrics: {
    full: "every event the question needs is among the first k",
    recall: "the share of the needed events among the first k (mean over questions)",
    currentFirst: "for questions with superseded values: every needed value that replaced older ones is among the first k and ranks above each of them that is",
  },
  summary,
  comparisons,
  rows: run.rows,
});

const pct = (x) => (x === null ? "    -" : `${(x * 100).toFixed(1)}%`.padStart(6));
console.log(`Wrote ${out}\n`);
console.log(`${"system".padEnd(18)} ${"slice".padEnd(16)} ${KS.map((x) => `full@${x}`).join("  ")}  recall@${k}  currentFirst@${k}`);
for (const system of systems) {
  for (const [slice, r] of Object.entries(summary[system])) {
    if (!r.n) continue;
    const cf = r[k].currentFirstN ? `${pct(r[k].currentFirst)} (${r[k].currentFirstN})` : "     -";
    console.log(`${system.padEnd(18)} ${`${slice} (${r.n})`.padEnd(16)} ${KS.map((x) => pct(r[x].full)).join("  ")}   ${pct(r[k].recall)}     ${cf}`);
  }
}
for (const c of comparisons) console.log(`\n${c.a} vs ${c.b}, full@${c.k}: wins ${c.wins.length} [${c.wins.join(", ")}], losses ${c.losses.length} [${c.losses.join(", ")}]`);

const n = questions.length;
const count = (s) => {
  const all = summary[s]?.all;
  if (!all?.n) return "no scored question";
  return `${pct(all[k].full).trim()} (${Math.round(all[k].full * all.n)}/${all.n})`;
};
const stem = comparisons[1];
const tail = run.aborted ? ` The run stopped early: ${run.aborted}.` : run.failed ? ` ${run.failed} of ${run.attempted} recalls failed; see the result file.` : "";
console.log(
  `RESULT: on ${n} derived-state questions, every needed event was in the first ${k} for ${ours} on ${count(ours)}, plain BM25 on ${count("bm25")} and stemmed BM25 on ${count("bm25-stem")}; ${ours} lost ${stem.losses.length} questions to stemmed BM25 and won ${stem.wins.length}.${tail}`,
);
