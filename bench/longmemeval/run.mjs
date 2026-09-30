#!/usr/bin/env node
// Usage: npm run build && node bench/longmemeval/run.mjs --limit 50
//
// Runs LongMemEval against this library: every question gets a fresh store
// holding its history, recall picks what the reader sees, an answerer answers,
// and the official judge prompt grades the answer. Writes
// bench/results/<date>-longmemeval.json (settings, model ids, commit, per-type
// and retrieval numbers, every answer) and, beside it, the answers in the
// official hypothesis format so the official evaluate_qa.py can re-judge them.
// See bench/longmemeval/README.md for every flag and what the numbers mean.
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { cpus, loadavg, totalmem } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { RESULTS_DIR, REPO_ROOT, isoDate, resultPath, runInfo, writeJson } from "../lib/run-info.mjs";
import { answererFromSpec, runProcess, subscriptionEnv } from "./answerers.mjs";
import { loadInstances, selectInstances } from "./dataset.mjs";
import { DATA_DIR, readManifest, sha256File } from "./download.mjs";
import { runInstances, summarize } from "./harness.mjs";
import { cachingEmbedder } from "./memory.mjs";
import { ANSWER_TEMPLATES, LONGMEMEVAL_COMMIT, READER_SOURCE, SCORING_SOURCE } from "./prompts.mjs";

/** `--rerank` shorthands for the two cross-encoders the library documents. */
const RERANK_MODELS = { minilm: "Xenova/ms-marco-MiniLM-L-6-v2", bge: "Xenova/bge-reranker-base" };

const { values: args } = parseArgs({
  options: {
    variant: { type: "string", default: "s" },
    data: { type: "string" },
    limit: { type: "string" },
    types: { type: "string" },
    retrieval: { type: "string", default: "hybrid" },
    "top-k": { type: "string", default: "20" },
    "recall-pool": { type: "string", default: "100" },
    freshness: { type: "string", default: "0" },
    rerank: { type: "string", default: "none" },
    "rerank-dtype": { type: "string", default: "fp32" },
    "rerank-depth": { type: "string" },
    expand: { type: "boolean", default: false },
    "aggregate-top-k": { type: "string" },
    "chain-of-note": { type: "boolean", default: false },
    reading: { type: "string", default: "con" },
    answerer: { type: "string", default: "claude" },
    "answer-model": { type: "string", default: "sonnet" },
    judge: { type: "string", default: "claude" },
    "judge-model": { type: "string", default: "sonnet" },
    "claude-bin": { type: "string", default: "claude" },
    concurrency: { type: "string", default: "4" },
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

// --- the library, as built -------------------------------------------------
const distEntry = join(REPO_ROOT, "dist", "index.js");
if (!existsSync(distEntry)) fail("dist/ is missing: run `npm run build` first (the benchmark measures the built package).");
const lib = await import(pathToFileURL(distEntry).href);
if (args.out !== undefined && !args.out.endsWith(".json")) fail("--out must name a .json file (the answers go beside it as .hypotheses.jsonl)");

// --- the dataset, checked against the pin ----------------------------------
const manifest = readManifest();
const file = manifest.files[args.variant];
if (!file) fail(`Unknown --variant "${args.variant}" (have: ${Object.keys(manifest.files).join(", ")})`);
const dataPath = args.data ?? join(DATA_DIR, file.path);
if (!existsSync(dataPath)) fail(`${dataPath} is missing: run \`node bench/longmemeval/download.mjs --variant ${args.variant}\` first.`);
const dataSha256 = await sha256File(dataPath);
const pinned = file.sha256 !== null && dataSha256 === file.sha256;
if (!pinned && !args["allow-unpinned"]) {
  fail(
    file.sha256
      ? `${dataPath} is not the pinned file (SHA-256 ${dataSha256}, dataset.json says ${file.sha256}). Pass --allow-unpinned to run it anyway; the result will say so.`
      : `dataset.json records no SHA-256 for ${file.path} yet: run \`node bench/longmemeval/download.mjs --pin\` and commit dataset.json, or pass --allow-unpinned; the result will say so.`,
  );
}
const types = args.types ? args.types.split(",").map((t) => t.trim()).filter(Boolean) : [];
const limit = args.limit !== undefined ? int("limit", 1) : undefined;
const all = loadInstances(dataPath);
let instances;
try {
  instances = selectInstances(all, { ...(limit !== undefined ? { limit } : {}), ...(types.length ? { types } : {}) });
} catch (e) {
  fail(`--types: ${e.message}`);
}
if (instances.length === 0) fail("No questions selected.");

// --- retrieval, answerer and judge -----------------------------------------
if (!["hybrid", "keyword"].includes(args.retrieval)) fail(`--retrieval must be hybrid or keyword (got ${args.retrieval})`);
if (!ANSWER_TEMPLATES[args.reading]) fail(`--reading must be ${Object.keys(ANSWER_TEMPLATES).join(" or ")} (got ${args.reading})`);
const topK = int("top-k", 1);
const concurrency = int("concurrency", 1);
const freshness = Number(args.freshness);
if (!Number.isFinite(freshness) || freshness < 0) fail(`--freshness must be a number >= 0 (got ${args.freshness})`);
// Memory building embeds through a memo (histories share most of their messages); the question never does.
const queryEmbedder = args.retrieval === "hybrid" ? new lib.LocalEmbedder() : undefined;
const embedder = queryEmbedder ? cachingEmbedder(queryEmbedder) : undefined;
if (embedder) {
  try {
    await embedder.embed(["warm-up"]);
  } catch (e) {
    fail(`Hybrid retrieval needs the on-device embedder (optional dependency @huggingface/transformers, and a one-time model download): ${e.message}\nOr pass --retrieval keyword.`);
  }
}
const rerankModel = args.rerank === "none" ? null : (RERANK_MODELS[args.rerank] ?? args.rerank);
const reranker = rerankModel ? new lib.LocalReranker({ model: rerankModel, dtype: args["rerank-dtype"] }) : null;
if (reranker) {
  try {
    await reranker.score("warm-up", ["warm-up"]);
  } catch (e) {
    fail(`--rerank ${args.rerank} needs the on-device cross-encoder ${rerankModel} (optional dependency @huggingface/transformers, and a one-time model download): ${e.message}`);
  }
}
const aggregateTopK = args["aggregate-top-k"] !== undefined ? int("aggregate-top-k", 1) : null;
const recallPool = int("recall-pool", 1);
const rerankDepth = args["rerank-depth"] !== undefined ? int("rerank-depth", 1) : null;
if (rerankDepth !== null && !reranker) fail("--rerank-depth needs --rerank.");
const claudeCommand = [args["claude-bin"]];
const answerer = answererFromSpec(args.answerer, { model: args["answer-model"], claudeCommand });
const judge = answerer ? answererFromSpec(args.judge, { model: args["judge-model"], claudeCommand }) : null;
let claudeVersion = null;
if ([args.answerer, args.judge].includes("claude")) {
  const v = await runProcess([...claudeCommand, "--version"], "", { env: subscriptionEnv(), timeoutMs: 30_000 }).catch(() => null);
  claudeVersion = v && v.code === 0 ? v.stdout.trim() : null;
  if (!claudeVersion) fail(`\`${args["claude-bin"]} --version\` failed: is the Claude Code CLI installed and logged in with a subscription?`);
}

// --- settings, and where a partial run is kept ------------------------------
const info = runInfo();
const settings = {
  variant: args.variant,
  selection: { limit: args.limit === undefined ? null : Number(args.limit), types: types.length ? types.join(",") : null, stratified: args.limit !== undefined, questions: instances.length },
  store: "SqliteMemoryStore(':memory:'), a fresh one per question",
  ingestion: "one memory per message: user turns UserInput, assistant turns AIInferred, memoryType Conversation, validFrom = session date, decayRate 0; nothing extracted or summarised",
  retrieval: args.retrieval,
  embedder: embedder ? { model: embedder.model, modelVersion: embedder.modelVersion, dimensions: embedder.dimensions } : null,
  recall: `HybridRetriever.recall(question, { limit: ${recallPool}${recallPool !== 100 ? `, candidates: ${Math.ceil(recallPool / 2)}` : ""}${args.expand ? ", expand: { now: question_date }" : ""} })${reranker ? `, reranked by the cross-encoder${rerankDepth !== null ? ` (its best ${rerankDepth} candidates)` : ""}` : ""}, hits grouped into rounds (a user turn and the turn after it)`,
  reranker: reranker ? { model: reranker.model, dtype: reranker.dtype, depth: rerankDepth !== null ? `the best ${rerankDepth} of ${recallPool} recalled` : `all recalled (${recallPool})` } : null,
  expand: args.expand,
  freshness,
  topK,
  aggregateTopK,
  reading: args.reading,
  chainOfNote: args["chain-of-note"],
  historyFormat: "json",
  concurrency,
  recallTiming: "per question, the wall-clock and CPU time of the HybridRetriever.recall call alone (query embedding, keyword and vector search, fusion and any reranking; not building the memory, grouping into rounds, answering or judging), with no other question's memory building or recall running in this process",
};
const answererInfo = answerer ? { ...answerer.describe(), ...(answerer.kind === "claude-cli" ? { cliVersion: claudeVersion } : {}) } : null;
const judgeInfo = judge ? { ...judge.describe(), ...(judge.kind === "claude-cli" ? { cliVersion: claudeVersion } : {}) } : null;
const runKey = createHash("sha256")
  .update(JSON.stringify({ dataSha256, commit: info.commit, settings: { ...settings, concurrency: undefined }, answererInfo, judgeInfo, ids: instances.map((x) => x.question_id) }))
  .digest("hex")
  .slice(0, 16);
const progressPath = join(RESULTS_DIR, ".progress", `longmemeval-${runKey}.jsonl`);
mkdirSync(join(RESULTS_DIR, ".progress"), { recursive: true });
const done = new Map();
if (existsSync(progressPath) && readFileSync(progressPath, "utf8").trim() !== "") {
  if (args.fresh) writeFileSync(progressPath, "");
  else if (!args.resume) fail(`A partial run with these exact settings is in ${progressPath}.\nPass --resume to continue it, or --fresh to start over.`);
  else for (const line of readFileSync(progressPath, "utf8").split("\n").filter(Boolean)) {
    const row = JSON.parse(line);
    if (!row.error) done.set(row.question_id, row);
  }
}
const todo = instances.filter((x) => !done.has(x.question_id));

const options = [reranker && `rerank ${reranker.model} ${reranker.dtype}${rerankDepth !== null ? ` top ${rerankDepth}` : ""}`, args.expand && "expand", aggregateTopK && `top ${aggregateTopK} rounds when counting`, args["chain-of-note"] && "chain-of-note when counting"].filter(Boolean);
console.log(
  `LongMemEval_${args.variant}: ${instances.length} questions (${done.size} already done), retrieval ${args.retrieval}, top ${topK} rounds, reading ${args.reading}${options.length ? ` (${options.join(", ")})` : ""}, ` +
    `answerer ${answererInfo ? `${answererInfo.kind} ${answererInfo.requestedModel ?? answererInfo.command}` : "none"}, judge ${judgeInfo ? `${judgeInfo.kind} ${judgeInfo.requestedModel ?? judgeInfo.command}` : "none"}` +
    `${answerer ? `, up to ${todo.length * (judge ? 2 : 1)} model calls` : ""}.`,
);
if (!pinned) console.log(`WARNING: ${dataPath} is not verified against dataset.json; the result will record that.`);

// --- the run ------------------------------------------------------------------
let finished = done.size;
const started = Date.now();
const loadAtStart = loadavg().map((x) => Math.round(x * 100) / 100);
const onRow = (row) => {
  appendFileSync(progressPath, `${JSON.stringify(row)}\n`);
  finished += 1;
  const t = row.retrieval?.metrics?.session?.["recall_any@10"];
  const verdict = row.error ? `ERROR ${row.error}` : typeof row.label === "boolean" ? (row.label ? "correct" : "wrong") : row.hypothesis ? "answered" : "retrieved";
  console.log(`[${finished}/${instances.length}] ${row.question_id} ${row.question_type}${t === undefined ? "" : ` session recall@10=${t}`}${row.recall ? ` recall ${Math.round(row.recall.ms)}ms` : ""} ${verdict}${row.ms ? ` (${(row.ms / 1000).toFixed(1)}s)` : ""}`);
};
let stopped = null;
try {
  await runInstances(
    lib,
    todo,
    { embedder, queryEmbedder, reranker, rerankDepth, topK, aggregateTopK, freshness, expand: args.expand, recallPool, reading: args.reading, chainOfNote: args["chain-of-note"], answerer, judge },
    { concurrency, onRow },
  );
} catch (e) {
  stopped = e;
}
if (stopped) {
  console.error(`\nStopped: ${stopped.message}\nProgress is kept in ${progressPath}; run the same command with --resume to continue.`);
  process.exit(2);
}

// --- the result ----------------------------------------------------------------
const byId = new Map(readFileSync(progressPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).map((r) => [r.question_id, r]));
const rows = instances.map((x) => byId.get(x.question_id)).filter(Boolean);
const summary = summarize(rows);
const out = args.out ?? resultPath(RESULTS_DIR, isoDate(), "longmemeval");
writeJson(out, {
  benchmark: "LongMemEval",
  date: new Date().toISOString(),
  ...info,
  dataset: { name: manifest.name, repo: manifest.repo, revision: manifest.revision, file: basename(dataPath), sha256: dataSha256, verifiedAgainstManifest: pinned },
  scoring: {
    code: `github.com/xiaowu0162/LongMemEval@${LONGMEMEVAL_COMMIT}`,
    judgePrompts: SCORING_SOURCE,
    readerPrompt: READER_SOURCE,
    label: "'yes' in judge_response.strip().lower()",
    officialJudgeModel: "gpt-4o-2024-08-06",
    ...(args["chain-of-note"]
      ? { readerNote: "Questions analyzeQuery marks as counting across memories were read with CHAIN_OF_NOTE_TEMPLATE (bench/longmemeval/prompts.mjs), not an official template; each row's `reading` says which one it got." }
      : {}),
    note: judgeInfo
      ? "Official prompts and rule; the judge model is the one named under `judge`, not gpt-4o. `hypothesesFile` is in the official format, so evaluate_qa.py can re-judge it with gpt-4o."
      : "Not judged. `hypothesesFile` is in the official format for evaluate_qa.py.",
  },
  settings,
  // What the recall times were measured on: the load average is over the whole machine, not this run.
  machine: { cpu: cpus()[0]?.model ?? null, cores: cpus().length, memoryGb: Math.round(totalmem() / 2 ** 30), loadAverage: { atStart: loadAtStart, atEnd: loadavg().map((x) => Math.round(x * 100) / 100) } },
  answerer: answererInfo,
  judge: judgeInfo,
  wallClockSeconds: Math.round((Date.now() - started) / 1000),
  summary,
  hypothesesFile: answerer ? basename(out).replace(/\.json$/, ".hypotheses.jsonl") : null,
  questions: rows,
});
if (answerer) {
  writeFileSync(
    out.replace(/\.json$/, ".hypotheses.jsonl"),
    rows.filter((r) => typeof r.hypothesis === "string").map((r) => `${JSON.stringify({ question_id: r.question_id, hypothesis: r.hypothesis })}\n`).join(""),
  );
}

// With every question answered the result holds it all, and a rerun starts over;
// with failures, the progress stays so --resume retries just those.
if (summary.errors === 0) rmSync(progressPath, { force: true });

const pct = (x) => (x === null || x === undefined ? "—" : `${(x * 100).toFixed(1)}%`);
console.log(`\nWrote ${out}`);
if (summary.qa.questions) {
  console.log(`QA accuracy ${pct(summary.qa.overallAccuracy)} overall, ${pct(summary.qa.taskAveragedAccuracy)} task-averaged, abstention ${pct(summary.qa.abstention.accuracy)} (n=${summary.qa.abstention.n})`);
  for (const [t, v] of Object.entries(summary.qa.byType)) console.log(`  ${t.padEnd(26)} ${pct(v.accuracy).padStart(6)}  (n=${v.n})`);
}
const s = summary.retrieval.session;
console.log(`Retrieval (${summary.retrieval.questions} question${summary.retrieval.questions === 1 ? "" : "s"}): session recall_any@5 ${pct(s["recall_any@5"])}, @10 ${pct(s["recall_any@10"])}; recall_all@10 ${pct(s["recall_all@10"])}; ndcg_any@10 ${pct(s["ndcg_any@10"])}`);
const rt = summary.recall;
if (rt) {
  console.log(
    `Recall time (the recall call alone, ${rt.n} questions): p50 ${rt.ms.p50} ms, p95 ${rt.ms.p95} ms, max ${rt.ms.max} ms; CPU p50 ${rt.cpuMs.p50} ms, p95 ${rt.cpuMs.p95} ms` +
      `${rt.load1 ? `; machine load (1 min) ${rt.load1.mean} on average, ${rt.load1.max} at most, on ${cpus().length} cores` : ""}`,
  );
}
const shown = summary.retrieval.shown;
if (shown) {
  console.log(`Shown to the reader (not an official metric): every evidence turn in ${pct(shown.allEvidence)} of questions, ${pct(shown.evidenceFound)} of evidence turns, ${shown.meanRounds} rounds on average`);
  for (const [t, v] of Object.entries(shown.byType)) console.log(`  ${t.padEnd(26)} all evidence ${pct(v.allEvidence).padStart(6)}  (n=${v.n}, ${v.meanRounds} rounds)`);
}
if (summary.errors) {
  console.log(`${summary.errors} question(s) failed after retries and are not in the accuracy; see "error" in the result file.`);
  console.log(`Run the same command with --resume to retry just those (progress: ${progressPath}).`);
}
