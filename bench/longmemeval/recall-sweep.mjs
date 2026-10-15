#!/usr/bin/env node
// Usage: npm run build && node bench/longmemeval/recall-sweep.mjs --expand --aggregate-top-k 40 \
//          --arm none --arm minilm:q8:20 --arm minilm:fp32:all
//
// How long recall takes, and what it would put in front of the reader, under
// several reranker settings ("arms") at once. No model answers or judges
// anything, so it costs no subscription calls. Each question's history goes
// into memory once; every arm then recalls from it with a fresh retriever
// (cold, as in run.mjs), in an order that rotates from question to question so
// no arm always goes first. One question at a time: a recall is never timed
// while another is running.
//
// An arm is `none`, or parts joined by `+`:
//   <model>:<dtype>:<depth>   a cross-encoder — model `minilm`, `bge` or a Hugging
//                             Face cross-encoder id, depth a number of candidates or `all`
//   content-words             recall option contentWords
//   keyword-weight:<x>        recall option keywordWeight
//   diversify:<n>             recall option diversify, n memories per session first
//   build:<dir>               another build of the library (e.g. the commit before,
//                             compiled to <dir>), recalling over an exact copy of the
//                             memory: same ids, anchors and vectors, so ties fall the same way
// e.g. `--arm none --arm diversify:2 --arm content-words+keyword-weight:0.5+diversify:3`.
//
// Writes bench/results/<date>-lme-recall-sweep.json: per arm, the recall call's
// wall-clock and CPU time, the share of recalls within --budget-ms, the
// official retrieval averages, how often the reader would see every evidence
// turn, in how many questions it would see the same rounds as the first arm,
// and which questions newly see (or no longer see) every evidence turn
// against the first arm. A question's accuracy can only move when the rounds
// it is shown do. The last line printed is `RESULT: …`, one sentence.
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { cpus, loadavg, totalmem } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { RESULTS_DIR, REPO_ROOT, isoDate, resultPath, runInfo, writeJson } from "../lib/run-info.mjs";
import { corpusOf, isAbstention, loadInstances, parseSessionDate, retrievalSkipReason, selectInstances } from "./dataset.mjs";
import { DATA_DIR, readManifest, sha256File } from "./download.mjs";
import { cachingEmbedder, fastPathOptions, ingestHistory, recallRounds } from "./memory.mjs";
import { retrievalMetrics, shownEvidence, summarizeRecallTime, summarizeRetrieval } from "./metrics.mjs";

const RERANK_MODELS = { minilm: "Xenova/ms-marco-MiniLM-L-6-v2", bge: "Xenova/bge-reranker-base" };

const { values: args } = parseArgs({
  options: {
    variant: { type: "string", default: "s" },
    data: { type: "string" },
    limit: { type: "string" },
    types: { type: "string" },
    "top-k": { type: "string", default: "20" },
    "aggregate-top-k": { type: "string" },
    "recall-pool": { type: "string", default: "100" },
    expand: { type: "boolean", default: false },
    arm: { type: "string", multiple: true, default: ["none"] },
    "budget-ms": { type: "string", default: "300" },
    repeat: { type: "string", default: "1" },
    out: { type: "string" },
    resume: { type: "boolean", default: false },
    fresh: { type: "boolean", default: false },
    "allow-unpinned": { type: "boolean", default: false },
  },
});

const fail = (message) => {
  console.error(message);
  process.exit(1);
};
const int = (name, min) => {
  const n = Number(args[name]);
  if (!Number.isInteger(n) || n < min) fail(`--${name} must be an integer >= ${min} (got ${args[name]})`);
  return n;
};
const round2 = (x) => Math.round(x * 100) / 100;

const distEntry = join(REPO_ROOT, "dist", "index.js");
if (!existsSync(distEntry)) fail("dist/ is missing: run `npm run build` first (the benchmark measures the built package).");
const lib = await import(pathToFileURL(distEntry).href);
if (args.out !== undefined && !args.out.endsWith(".json")) fail("--out must name a .json file");

// --- the dataset, checked against the pin, as run.mjs checks it -------------
const manifest = readManifest();
const file = manifest.files[args.variant];
if (!file) fail(`Unknown --variant "${args.variant}" (have: ${Object.keys(manifest.files).join(", ")})`);
const dataPath = args.data ?? join(DATA_DIR, file.path);
if (!existsSync(dataPath)) fail(`${dataPath} is missing: run \`node bench/longmemeval/download.mjs --variant ${args.variant}\` first.`);
const dataSha256 = await sha256File(dataPath);
const pinned = file.sha256 !== null && dataSha256 === file.sha256;
if (!pinned && !args["allow-unpinned"]) fail(`${dataPath} is not the pinned file (SHA-256 ${dataSha256}). Pass --allow-unpinned to run it anyway; the result will say so.`);
const types = args.types ? args.types.split(",").map((t) => t.trim()).filter(Boolean) : [];
let instances;
try {
  instances = selectInstances(loadInstances(dataPath), { ...(args.limit !== undefined ? { limit: int("limit", 1) } : {}), ...(types.length ? { types } : {}) });
} catch (e) {
  fail(`--types: ${e.message}`);
}
if (instances.length === 0) fail("No questions selected.");

// --- the arms ------------------------------------------------------------------
const topK = int("top-k", 1);
const aggregateTopK = args["aggregate-top-k"] !== undefined ? int("aggregate-top-k", 1) : null;
const recallPool = int("recall-pool", 1);
const budgetMs = int("budget-ms", 1);
const repeat = int("repeat", 1);
const rerankers = new Map();
const builds = new Map();
const arms = [];
for (const spec of args.arm) {
  const arm = { name: "none", reranker: null, depth: null, recallOptions: {}, build: null };
  if (spec === "none") {
    arms.push(arm);
    continue;
  }
  const names = [];
  let contentWords = false, keywordWeight = null, diversify = null;
  for (const part of spec.split("+")) {
    const [kind, ...rest] = part.split(":");
    if (part === "content-words") contentWords = true;
    else if (kind === "keyword-weight") {
      keywordWeight = Number(rest[0]);
      if (rest.length !== 1 || !(Number.isFinite(keywordWeight) && keywordWeight >= 0)) fail(`--arm ${spec}: keyword-weight must be a number >= 0`);
    } else if (kind === "diversify") {
      diversify = Number(rest[0]);
      if (rest.length !== 1 || !Number.isInteger(diversify) || diversify < 1) fail(`--arm ${spec}: diversify must be an integer >= 1`);
    } else if (kind === "build") {
      const dir = resolve(rest.join(":"));
      if (!existsSync(join(dir, "index.js"))) fail(`--arm ${spec}: ${dir}/index.js is missing (compile that commit's src/ there first)`);
      if (!builds.has(dir)) builds.set(dir, await import(pathToFileURL(join(dir, "index.js")).href));
      arm.build = dir;
    } else {
      if (arm.reranker) fail(`--arm ${spec}: one cross-encoder per arm`);
      const [short, dtype = "fp32", depthSpec = "all"] = part.split(":");
      const model = RERANK_MODELS[short] ?? short;
      const depth = depthSpec === "all" ? null : Number(depthSpec);
      if (depth !== null && (!Number.isInteger(depth) || depth < 1)) fail(`--arm ${spec}: depth must be an integer >= 1 or "all"`);
      const key = `${model}:${dtype}`;
      if (!rerankers.has(key)) rerankers.set(key, new lib.LocalReranker({ model, dtype }));
      Object.assign(arm, { reranker: rerankers.get(key), depth });
      names.push(`${short}:${dtype}:${depthSpec}`);
      continue;
    }
    names.push(part);
  }
  arm.recallOptions = fastPathOptions({ contentWords, keywordWeight, diversify }).options;
  // An older build may not know the newer options; it would read them as a scope.
  if (arm.build && Object.keys(arm.recallOptions).length > 0) fail(`--arm ${spec}: a build arm recalls as that build does; give it no recall options`);
  arm.name = names.join("+");
  arms.push(arm);
}
if (new Set(arms.map((a) => a.name)).size !== arms.length) fail("Each --arm must be different.");
const queryEmbedder = new lib.LocalEmbedder();
const embedder = cachingEmbedder(queryEmbedder);
try {
  await embedder.embed(["warm-up"]);
  for (const r of rerankers.values()) await r.score("warm-up", ["warm-up"]);
} catch (e) {
  fail(`The on-device embedder and cross-encoders need @huggingface/transformers and a one-time model download: ${e.message}`);
}

const info = runInfo();
const settings = {
  variant: args.variant,
  selection: { limit: args.limit === undefined ? null : Number(args.limit), types: types.length ? types.join(",") : null, questions: instances.length },
  store: "SqliteMemoryStore(':memory:'), one per question, shared by its arms",
  retrieval: "hybrid",
  embedder: { model: queryEmbedder.model, modelVersion: queryEmbedder.modelVersion, dimensions: queryEmbedder.dimensions },
  recall: `HybridRetriever.recall(question, { limit: ${recallPool}${recallPool !== 100 ? `, candidates: ${Math.ceil(recallPool / 2)}` : ""}${args.expand ? ", expand: { now: question_date }" : ""} }), a fresh retriever per arm`,
  expand: args.expand,
  topK,
  aggregateTopK,
  arms: arms.map((a) => ({
    name: a.name,
    reranker: a.reranker ? { model: a.reranker.model, dtype: a.reranker.dtype, depth: a.depth ?? `all recalled (${recallPool})` } : null,
    recallOptions: a.recallOptions,
    build: a.build ? relative(REPO_ROOT, a.build) || "." : null,
  })),
  armOrder: repeat > 1 ? "rotates by one arm per question and per repetition" : "rotates by one arm per question",
  repeat,
  budgetMs,
  recallTiming: `per question and arm, the wall-clock and CPU time of the HybridRetriever.recall call alone (query embedding, keyword and vector search, fusion and any reranking), one recall at a time${repeat > 1 ? `; the median of ${repeat} recalls, each with a fresh retriever` : ""}`,
};
const runKey = createHash("sha256")
  .update(JSON.stringify({ dataSha256, commit: info.commit, settings, ids: instances.map((x) => x.question_id) }))
  .digest("hex")
  .slice(0, 16);
const progressPath = join(RESULTS_DIR, ".progress", `recall-sweep-${runKey}.jsonl`);
mkdirSync(join(RESULTS_DIR, ".progress"), { recursive: true });
const done = new Set();
if (existsSync(progressPath) && readFileSync(progressPath, "utf8").trim() !== "") {
  if (args.fresh) writeFileSync(progressPath, "");
  else if (!args.resume) fail(`A partial sweep with these exact settings is in ${progressPath}.\nPass --resume to continue it, or --fresh to start over.`);
  else for (const line of readFileSync(progressPath, "utf8").split("\n").filter(Boolean)) done.add(JSON.parse(line).question_id);
}
const todo = instances.filter((x) => !done.has(x.question_id));
console.log(`LongMemEval_${args.variant} recall sweep: ${instances.length} questions (${done.size} already done), arms ${arms.map((a) => a.name).join(", ")}${args.expand ? ", expand" : ""}, top ${topK} rounds${aggregateTopK ? ` (${aggregateTopK} when counting)` : ""}. No model is called.`);

/**
 * The same memory in another build's store: every node restored as it is
 * (id, anchors, valid time) and every vector as stored, so the two builds
 * rank the same data and differ only in their code.
 */
async function copyMemory(buildLib, memory) {
  const store = new buildLib.SqliteMemoryStore(":memory:");
  try {
    for (const node of await memory.store.listNodes()) await store.restoreNode(node);
    for (const e of await memory.store.listEmbeddings(queryEmbedder.model)) {
      await store.setEmbedding({ nodeId: e.nodeId, model: e.model, modelVersion: e.modelVersion, dimensions: e.dimensions, metric: e.metric, vector: e.vector });
    }
  } catch (e) {
    store.close();
    throw e;
  }
  return { ...memory, store };
}

// --- the sweep -----------------------------------------------------------------
const started = Date.now();
const loadAtStart = loadavg().map(round2);
let finished = done.size;
const position = new Map(instances.map((x, i) => [x.question_id, i]));
for (const instance of todo) {
  const t0 = Date.now();
  const memory = await ingestHistory(lib, instance, { embedder, queryEmbedder });
  const row = { question_id: instance.question_id, question_type: instance.question_type, abstention: isAbstention(instance.question_id), memories: memory.memories, arms: {} };
  const copies = new Map();
  try {
    for (const [dir, buildLib] of builds) copies.set(dir, await copyMemory(buildLib, memory));
    const cues = lib.analyzeQuery(instance.question, { now: parseSessionDate(instance.question_date) });
    const k = cues.aggregation && aggregateTopK ? aggregateTopK : topK;
    const { corpus, correct } = corpusOf(instance);
    const skipped = retrievalSkipReason(instance);
    Object.assign(row, { cues: { aggregation: cues.aggregation, order: cues.order, windows: cues.windows.map((w) => w.phrase), parts: cues.parts.length }, rounds: k });
    const first = position.get(instance.question_id) % arms.length;
    const times = new Map(arms.map((a) => [a.name, []]));
    for (let rep = 0; rep < repeat; rep += 1) {
      for (let j = 0; j < arms.length; j += 1) {
        const arm = arms[(first + rep + j) % arms.length];
        const armLib = arm.build ? builds.get(arm.build) : lib;
        const armMemory = arm.build ? copies.get(arm.build) : memory;
        const retriever = new armLib.HybridRetriever(armMemory.store, queryEmbedder, arm.reranker ? { reranker: arm.reranker, ...(arm.depth ? { rerankDepth: arm.depth } : {}) } : {});
        const { rounds, recall } = await recallRounds({ ...armMemory, retriever }, instance, { expand: args.expand, recallPool, recallOptions: arm.recallOptions });
        times.get(arm.name).push({ ...recall, load1: round2(loadavg()[0]) });
        if (rep > 0) continue;
        const shown = rounds.slice(0, k).map((r) => r.id);
        row.arms[arm.name] = {
          retrieval: skipped ? { skipped } : { skipped: null, metrics: retrievalMetrics(rounds.map((r) => r.id), correct, corpus.map((c) => c.id)), shown: shownEvidence(shown, correct) },
          shownRounds: shown,
        };
      }
    }
    // With --repeat, each time is the median of the arm's recalls of this question.
    for (const arm of arms) {
      const t = times.get(arm.name);
      const mid = (f) => t.map(f).sort((a, b) => a - b)[Math.floor((t.length - 1) / 2)];
      row.arms[arm.name].recall = { ms: mid((x) => x.ms), cpuMs: mid((x) => x.cpuMs), load1: mid((x) => x.load1), ...(repeat > 1 ? { recalls: t.length } : {}) };
    }
  } finally {
    memory.store.close();
    for (const copy of copies.values()) copy.store.close();
  }
  appendFileSync(progressPath, `${JSON.stringify(row)}\n`);
  finished += 1;
  console.log(`[${finished}/${instances.length}] ${row.question_id} ${row.question_type} ${arms.map((a) => `${a.name} ${Math.round(row.arms[a.name].recall.ms)}ms`).join(", ")} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
}

// --- the result ------------------------------------------------------------------
const byId = new Map(readFileSync(progressPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).map((r) => [r.question_id, r]));
const rows = instances.map((x) => byId.get(x.question_id)).filter(Boolean);
const sameRounds = (a, b) => [...a].sort().join("\n") === [...b].sort().join("\n");
const allShown = (r, name) => r.arms[name].retrieval.shown?.all;
const summary = Object.fromEntries(
  arms.map((arm) => {
    const armRows = rows.map((r) => ({ question_id: r.question_id, question_type: r.question_type, ...r.arms[arm.name] }));
    const retrieval = summarizeRetrieval(armRows);
    const scored = rows.filter((r) => allShown(r, arm.name) !== undefined && allShown(r, arms[0].name) !== undefined);
    return [
      arm.name,
      {
        recall: summarizeRecallTime(armRows),
        withinBudget: { ms: round2(armRows.filter((r) => r.recall.ms <= budgetMs).length / armRows.length), cpuMs: round2(armRows.filter((r) => r.recall.cpuMs <= budgetMs).length / armRows.length) },
        retrieval: { questions: retrieval.questions, session: retrieval.session, turn: retrieval.turn },
        shown: retrieval.shown ?? null,
        sameRoundsAs: { arm: arms[0].name, questions: rows.filter((r) => sameRounds(r.arms[arm.name].shownRounds, r.arms[arms[0].name].shownRounds)).length, of: rows.length },
        // Which questions this arm newly shows every evidence turn for, and which it no longer does.
        allEvidenceVs: {
          arm: arms[0].name,
          gained: scored.filter((r) => allShown(r, arm.name) === 1 && allShown(r, arms[0].name) === 0).map((r) => r.question_id),
          lost: scored.filter((r) => allShown(r, arm.name) === 0 && allShown(r, arms[0].name) === 1).map((r) => r.question_id),
        },
      },
    ];
  }),
);
const out = args.out ?? resultPath(RESULTS_DIR, isoDate(), "lme-recall-sweep");
writeJson(out, {
  benchmark: "LongMemEval recall sweep",
  date: new Date().toISOString(),
  ...info,
  dataset: { name: manifest.name, repo: manifest.repo, revision: manifest.revision, file: basename(dataPath), sha256: dataSha256, verifiedAgainstManifest: pinned },
  settings,
  machine: { cpu: cpus()[0]?.model ?? null, cores: cpus().length, memoryGb: Math.round(totalmem() / 2 ** 30), loadAverage: { atStart: loadAtStart, atEnd: loadavg().map(round2) } },
  wallClockSeconds: Math.round((Date.now() - started) / 1000),
  summary,
  questions: rows,
});
rmSync(progressPath, { force: true });

const pct = (x) => (x === null || x === undefined ? "—" : `${(x * 100).toFixed(1)}%`);
console.log(`\nWrote ${out}`);
const w = Math.max(...arms.map((a) => a.name.length));
console.log(`${"arm".padEnd(w)}  recall p50 / p95 / max (ms)   CPU p50 / p95 (ms)   <=${budgetMs} ms   every evidence turn shown   +/- vs ${arms[0].name}   same rounds as ${arms[0].name}`);
for (const arm of arms) {
  const s = summary[arm.name];
  console.log(
    `${arm.name.padEnd(w)}  ${`${s.recall.ms.p50} / ${s.recall.ms.p95} / ${s.recall.ms.max}`.padEnd(28)} ${`${s.recall.cpuMs.p50} / ${s.recall.cpuMs.p95}`.padEnd(20)} ${pct(s.withinBudget.ms).padEnd(9)} ${pct(s.shown?.allEvidence).padEnd(27)} ${`+${s.allEvidenceVs.gained.length} / -${s.allEvidenceVs.lost.length}`.padEnd(arms[0].name.length + 9)} ${s.sameRoundsAs.questions} of ${s.sameRoundsAs.of}`,
  );
}
const load = summary[arms[0].name].recall.load1;
if (load) console.log(`Machine load (1 min) while recalling: ${load.mean} on average, ${load.max} at most, on ${cpus().length} cores.`);
// One sentence for whoever started this unattended: the best arm by evidence shown, against the first.
const best = arms.slice(1).reduce((b, a) => (b === null || (summary[a.name].shown?.allEvidence ?? -1) > (summary[b.name].shown?.allEvidence ?? -1) ? a : b), null);
const first = summary[arms[0].name];
console.log(
  best
    ? `RESULT: over ${rows.length} questions, ${best.name} showed every evidence turn in ${pct(summary[best.name].shown?.allEvidence)} against ${pct(first.shown?.allEvidence)} for ${arms[0].name} (+${summary[best.name].allEvidenceVs.gained.length} / -${summary[best.name].allEvidenceVs.lost.length} questions), recall p50 ${summary[best.name].recall.ms.p50} ms against ${first.recall.ms.p50} ms.`
    : `RESULT: over ${rows.length} questions, ${arms[0].name} showed every evidence turn in ${pct(first.shown?.allEvidence)}, recall p50 ${first.recall.ms.p50} ms.`,
);
