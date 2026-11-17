#!/usr/bin/env node
// Usage: npm run build && node bench/locomo/download.mjs && node bench/locomo/run.mjs --expand
//
// Runs LoCoMo against this library: each of the ten conversations goes into a
// fresh store, every question is recalled against it, the reader answers from
// what recall shows it, and the judge grades the answer — against the
// published key and, for the 99 answers the independent audit corrects,
// against the corrected key too. The 446 adversarial questions are reported
// beside the 1,540, never in them. Writes bench/results/<date>-locomo.json
// (settings, model ids, commit, every count, every answer). The last line
// printed is "RESULT: ...". See bench/locomo/README.md.
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { cpus, loadavg, totalmem } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { RESULTS_DIR, REPO_ROOT, isoDate, resultPath, runInfo, writeJson } from "../lib/run-info.mjs";
import { DEFAULT_SYSTEM_PROMPT, answererFromSpec, runProcess, subscriptionEnv } from "../longmemeval/answerers.mjs";
import { sha256File } from "../longmemeval/download.mjs";
import { SCORING_SOURCE as LONGMEMEVAL_JUDGE_SOURCE } from "../longmemeval/prompts.mjs";
import { CATEGORY_SIZES, loadAuditKey, loadConversations, selectQuestions } from "./dataset.mjs";
import { localPath, readLocomoManifest } from "./download.mjs";
import { runLocomo } from "./harness.mjs";
import { RECALL_POOL } from "./memory.mjs";
import { summarize } from "./metrics.mjs";
import { CONTEXT_TEMPLATE_DESCRIPTION, JUDGE_SYSTEM, KEYWORD_RULE_SOURCE, PROMPTS_SHA256, PROMPTS_SOURCE, READING_TEMPLATES } from "./prompts.mjs";

const { values: args } = parseArgs({
  options: {
    data: { type: "string" },
    audit: { type: "string" },
    conversations: { type: "string" },
    categories: { type: "string" },
    retrieval: { type: "string", default: "hybrid" },
    "top-k": { type: "string", default: "40" },
    "recall-pool": { type: "string", default: String(RECALL_POOL) },
    expand: { type: "boolean", default: false },
    reading: { type: "string", default: "c25" },
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

/** Every way out prints its outcome as the last line. */
const fail = (message, code = 1) => {
  console.error(message);
  console.log(`RESULT: the LoCoMo run did not finish: ${message.split("\n")[0]}`);
  process.exit(code);
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
if (args.out !== undefined && !args.out.endsWith(".json")) fail("--out must name a .json file");

// --- the data and the audit key, checked against their pins ----------------
const manifest = readLocomoManifest();
const pins = {};
const localFiles = {};
for (const [key, flag] of [["data", "data"], ["audit", "audit"]]) {
  const file = manifest.files[key];
  const path = args[flag] ?? localPath(file);
  if (!existsSync(path)) fail(`${path} is missing: run \`node bench/locomo/download.mjs\` first.`);
  const sha256 = await sha256File(path);
  pins[key] = { repo: file.repo, commit: file.commit, path: file.path, sha256, verifiedAgainstManifest: sha256 === file.sha256 };
  localFiles[key] = path;
  if (sha256 !== file.sha256 && !args["allow-unpinned"]) fail(`${path} is not the pinned file (SHA-256 ${sha256}, dataset.json says ${file.sha256}). Pass --allow-unpinned to run it anyway; the result will say so.`);
}
let conversations;
let auditKey;
try {
  conversations = loadConversations(localFiles.data);
  auditKey = loadAuditKey(localFiles.audit, conversations);
} catch (e) {
  fail(e.message);
}
const categories = args.categories ? args.categories.split(",").map((c) => Number(c.trim())) : [];
let selected;
try {
  selected = selectQuestions(conversations, { ...(args.conversations !== undefined ? { conversations: int("conversations", 1) } : {}), ...(categories.length ? { categories } : {}) });
} catch (e) {
  fail(`--categories: ${e.message}`);
}
const questions = selected.flatMap((c) => c.questions);
if (questions.length === 0) fail("No questions selected.");

// --- retrieval, reader and judges ---------------------------------------------
if (!["hybrid", "keyword"].includes(args.retrieval)) fail(`--retrieval must be hybrid or keyword (got ${args.retrieval})`);
if (!READING_TEMPLATES[args.reading]) fail(`--reading must be ${Object.keys(READING_TEMPLATES).join(" or ")} (got ${args.reading})`);
const topK = int("top-k", 1);
const recallPool = int("recall-pool", 1);
const concurrency = int("concurrency", 1);
const embedder = args.retrieval === "hybrid" ? new lib.LocalEmbedder() : undefined;
if (embedder) {
  try {
    await embedder.embed(["warm-up"]);
  } catch (e) {
    fail(`Hybrid retrieval needs the on-device embedder (optional dependency @huggingface/transformers, and a one-time model download): ${e.message}\nOr pass --retrieval keyword.`);
  }
}
const claudeCommand = [args["claude-bin"]];
let answerer;
let judge;
let abstentionJudge;
try {
  answerer = answererFromSpec(args.answerer, { model: args["answer-model"], claudeCommand });
  // The LoCoMo judge with its own system prompt; the adversarial questions get LongMemEval's judge, with LongMemEval's (none: the CLI's neutral one).
  judge = answerer ? answererFromSpec(args.judge, { model: args["judge-model"], system: JUDGE_SYSTEM, claudeCommand }) : null;
  abstentionJudge = answerer ? answererFromSpec(args.judge, { model: args["judge-model"], claudeCommand }) : null;
} catch (e) {
  fail(e.message);
}
let claudeVersion = null;
if (answerer && [args.answerer, args.judge].includes("claude")) {
  const v = await runProcess([...claudeCommand, "--version"], "", { env: subscriptionEnv(), timeoutMs: 30_000 }).catch(() => null);
  claudeVersion = v && v.code === 0 ? v.stdout.trim() : null;
  if (!claudeVersion) fail(`\`${args["claude-bin"]} --version\` failed: is the Claude Code CLI installed and logged in with a subscription?`);
}

// --- settings, and where a partial run is kept ---------------------------------
const info = runInfo();
const settings = {
  selection: { conversations: selected.length, categories: categories.length ? categories : null, questions: questions.length },
  store: "SqliteMemoryStore(':memory:'), a fresh one per conversation, every question of it asked of the same store",
  ingestion: "one memory per turn, its text \"<speaker>: <text>\" plus \" [shares <caption>]\" for a shared photo; both speakers UserInput, memoryType Conversation, validFrom = the session's date, decayRate 0; nothing extracted or summarised",
  retrieval: args.retrieval,
  embedder: embedder ? { model: embedder.model, modelVersion: embedder.modelVersion, dimensions: embedder.dimensions } : null,
  recall: `HybridRetriever.recall(question, { limit: ${recallPool}${recallPool !== RECALL_POOL ? `, candidates: ${Math.ceil(recallPool / 2)}` : ""}${args.expand ? ", expand: { now: the date of the conversation's last session }" : ""} })`,
  expand: args.expand,
  topK,
  reading: args.reading,
  context: CONTEXT_TEMPLATE_DESCRIPTION,
  concurrency,
  recallTiming: "per question, the wall-clock and CPU time of the HybridRetriever.recall call alone, recalls run one at a time with nothing else in this process",
};
const describe = (a) => (a ? { ...a.describe(), ...(a.kind === "claude-cli" ? { cliVersion: claudeVersion } : {}) } : null);
const answererInfo = describe(answerer);
const judgeInfo = describe(judge);
const abstentionJudgeInfo = describe(abstentionJudge);
const runKey = createHash("sha256")
  .update(JSON.stringify({ pins, commit: info.commit, settings: { ...settings, concurrency: undefined }, answererInfo, judgeInfo, abstentionJudgeInfo, ids: questions.map((q) => q.question_id) }))
  .digest("hex")
  .slice(0, 16);
const progressPath = join(RESULTS_DIR, ".progress", `locomo-${runKey}.jsonl`);
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
const todo = questions.filter((q) => !done.has(q.question_id));
const corrected = questions.filter((q) => auditKey.has(q.question_id)).length;
const adversarialCount = questions.filter((q) => q.adversarial).length;
console.log(
  `LoCoMo: ${selected.length} conversation(s), ${questions.length} questions (${questions.length - adversarialCount} scored, ${adversarialCount} adversarial; ${corrected} with an audit-corrected answer; ${done.size} already done), ` +
    `retrieval ${args.retrieval}${args.expand ? " with expand" : ""}, top ${topK} turns, reading ${args.reading}, ` +
    `answerer ${answererInfo ? `${answererInfo.kind} ${answererInfo.requestedModel ?? answererInfo.command}` : "none"}, judge ${judgeInfo ? `${judgeInfo.kind} ${judgeInfo.requestedModel ?? judgeInfo.command}` : "none"}` +
    `${answerer ? `, up to ${todo.length * (judge ? 2 : 1) + (judge ? todo.filter((q) => auditKey.has(q.question_id)).length : 0)} model calls` : ""}.`,
);
for (const [key, pin] of Object.entries(pins)) if (!pin.verifiedAgainstManifest) console.log(`WARNING: ${localFiles[key]} (${key}) is not verified against dataset.json; the result will record that.`);

// --- the run ---------------------------------------------------------------------
let finished = done.size;
const started = Date.now();
const loadAtStart = loadavg().map((x) => Math.round(x * 100) / 100);
const onRow = (row) => {
  appendFileSync(progressPath, `${JSON.stringify(row)}\n`);
  finished += 1;
  const shown = row.retrieval?.shown;
  const verdict = row.error
    ? `ERROR ${row.error}`
    : typeof row.label === "boolean"
      ? `${row.label ? "correct" : "wrong"}${typeof row.labelCorrected === "boolean" && row.labelCorrected !== row.label ? ` (${row.labelCorrected ? "correct" : "wrong"} by the corrected key)` : ""}`
      : row.hypothesis !== undefined
        ? "answered"
        : "retrieved";
  console.log(`[${finished}/${questions.length}] ${row.question_id} cat ${row.category}${shown ? ` evidence shown ${shown.found}/${shown.evidence}` : ""}${row.recall ? ` recall ${Math.round(row.recall.ms)}ms` : ""} ${verdict}`);
};
try {
  await runLocomo(lib, selected, { embedder, expand: args.expand, recallPool, topK, reading: args.reading, answerer, judge, abstentionJudge, auditKey }, { concurrency, onRow, done: new Set(done.keys()) });
} catch (e) {
  console.error(`\nStopped: ${e.message}\nAttempted ${e.attempted ?? 0} question(s) this time, succeeded ${e.succeeded ?? 0}; progress is kept in ${progressPath}. Run the same command with --resume to continue.`);
  console.log(`RESULT: the LoCoMo run stopped (${e.message}) after ${e.succeeded ?? 0} of ${e.attempted ?? 0} questions attempted this time succeeded; ${finished} of ${questions.length} are in the progress file, and --resume continues it.`);
  process.exit(2);
}

// --- the result ----------------------------------------------------------------------
const byId = new Map(readFileSync(progressPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).map((r) => [r.question_id, r]));
const rows = questions.map((q) => byId.get(q.question_id)).filter(Boolean);
const summary = summarize(rows);
if (summary.questions === summary.errors) fail(`Attempted ${summary.questions} question(s), succeeded 0; errors are recorded in ${progressPath}.`);
const out = args.out ?? resultPath(RESULTS_DIR, isoDate(), "locomo");
writeJson(out, {
  benchmark: "LoCoMo",
  date: new Date().toISOString(),
  ...info,
  dataset: { name: manifest.name, paper: manifest.paper, ...pins.data, categorySizes: CATEGORY_SIZES },
  auditKey: { ...pins.audit, corrections: auditKey.size, rule: "the audit's correct_answer for every entry whose error_type is not WRONG_CITATION; every other question keeps its published answer" },
  scoring: {
    readerPrompt: `${PROMPTS_SOURCE} (online_api.default, the "${args.reading}" answer prompt; file SHA-256 ${PROMPTS_SHA256})`,
    judgePrompt: `${PROMPTS_SOURCE} (llm_judge.system_prompt and user_prompt)`,
    label: "the last {\"label\": ...} object in the judge's response; with none, the one of CORRECT / WRONG it holds (bench/locomo/prompts.mjs judgeLabel)",
    scored: "categories 1-4 (1,540 questions); accuracy = judged CORRECT / judged",
    corrected: "the same answer judged again against the audit's correct_answer where the audit changes it; every other question keeps its first verdict",
    adversarial: `category 5, reported beside the scored ones and never in them. abstentionJudge: LongMemEval's official abstention judge prompt (${LONGMEMEVAL_JUDGE_SOURCE}), with the explanation in bench/locomo/prompts.mjs adversarialExplanation, the CLI's neutral system prompt ("${DEFAULT_SYSTEM_PROMPT}") and LongMemEval's yes/no rule; not an official LoCoMo grader, none exists. keywordRule: LoCoMo's own (${KEYWORD_RULE_SOURCE})`,
    note: judgeInfo ? "The judge model is the one named under `judge`, not the gpt-4o-mini most published LoCoMo numbers use." : "Not judged.",
  },
  settings,
  machine: { cpu: cpus()[0]?.model ?? null, cores: cpus().length, memoryGb: Math.round(totalmem() / 2 ** 30), loadAverage: { atStart: loadAtStart, atEnd: loadavg().map((x) => Math.round(x * 100) / 100) } },
  answerer: answererInfo,
  judge: judgeInfo,
  abstentionJudge: abstentionJudgeInfo,
  wallClockSeconds: Math.round((Date.now() - started) / 1000),
  summary,
  questions: rows,
});
if (summary.errors === 0) rmSync(progressPath, { force: true });

const pct = (x) => (x === null || x === undefined ? "—" : `${(x * 100).toFixed(1)}%`);
console.log(`\nWrote ${out}`);
console.log(`Attempted ${summary.questions} question(s), succeeded ${summary.questions - summary.errors}.`);
const sc = summary.scored;
if (sc.published.n) {
  console.log(`Scored (categories 1-4): ${pct(sc.published.accuracy)} against the published key (${sc.published.correct}/${sc.published.n}), ${pct(sc.corrected.accuracy)} against the audit's corrected key (${sc.corrected.correct}/${sc.corrected.n})`);
  for (const [c, v] of Object.entries(sc.byCategory)) console.log(`  category ${c} (n=${v.size}): ${pct(v.published.accuracy).padStart(6)} published, ${pct(v.corrected.accuracy).padStart(6)} corrected  (${v.published.n} judged)`);
  console.log(`  the corrected key changed ${sc.keyChanged.questions} answers: ${sc.keyChanged.wrongToCorrect} verdicts went wrong → correct, ${sc.keyChanged.correctToWrong} correct → wrong`);
}
const adv = summary.adversarial;
if (adv.keywordRule.n) console.log(`Adversarial (category 5, n=${adv.size}, not in the score): ${pct(adv.abstentionJudge.accuracy)} by the abstention judge (${adv.abstentionJudge.n} judged), ${pct(adv.keywordRule.accuracy)} by LoCoMo's keyword rule`);
const rs = summary.retrieval.scored;
console.log(`Retrieval, scored questions (${rs.n}; ${rs.skipped} with no evidence turn skipped): every evidence turn shown in ${pct(rs.shownAllEvidence)}, ${pct(rs.shownEvidenceTurns)} of evidence turns shown, any@10 ${pct(rs.at["any@10"])}, all@10 ${pct(rs.at["all@10"])}, all@50 ${pct(rs.at["all@50"])}`);
for (const [c, v] of Object.entries(summary.retrieval.byCategory)) console.log(`  category ${c} (n=${v.size}): all evidence shown ${pct(v.shownAllEvidence).padStart(6)}  (${v.n} counted)`);
if (summary.recall) console.log(`Recall time (the recall call alone, ${summary.recall.n} questions): p50 ${summary.recall.ms.p50} ms, p95 ${summary.recall.ms.p95} ms`);
const rt = summary.reader.inputTokensPerQuestion;
if (rt) console.log(`Reader input tokens per question: mean ${rt.mean}, p50 ${rt.p50}, p95 ${rt.p95} (${summary.reader.inputTokensReported} answers reported usage)`);
console.log(`Model calls: ${summary.calls.answer} answers, ${summary.calls.judge} verdicts, ${summary.calls.judgeCorrected} against the corrected key.`);
if (summary.errors) console.log(`${summary.errors} question(s) failed and are not in any number; see "error" in the result file. Run the same command with --resume to retry just those (progress: ${progressPath}).`);
const retrievalLine = `every evidence turn shown for ${pct(rs.shownAllEvidence)} of ${rs.n} scored questions`;
const headline = sc.published.n
  ? `${pct(sc.published.accuracy)} of ${sc.published.n} judged scored questions correct against the published key and ${pct(sc.corrected.accuracy)} against the audit's corrected key; ${adv.abstentionJudge.n ? `${pct(adv.abstentionJudge.accuracy)} of ${adv.abstentionJudge.n} adversarial questions judged abstaining` : "no adversarial question judged"}; ${retrievalLine}`
  : summary.answered
    ? `${summary.answered} questions answered and not judged; ${retrievalLine}`
    : `retrieval only, ${retrievalLine}`;
console.log(`RESULT: LoCoMo ${headline}; ${summary.questions - summary.errors} of ${summary.questions} questions succeeded; written to ${out}.`);
