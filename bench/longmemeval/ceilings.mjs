#!/usr/bin/env node
// Usage: npm run build && node bench/longmemeval/ceilings.mjs [--only reader|rerank]
//
// Two checks the 2026-11-17 review asks for before anyone spends on recall or
// on the reader (§ 3 items 5 and 7), run one after the other so neither is
// timed under the other's load:
//
// 1. The reader's ceiling. The 266 multi-session and temporal-reasoning
//    questions on the oracle variant (only the evidence sessions), read by the
//    published reader settings (`--expand --aggregate-top-k 40
//    --chain-of-note`) with room for the whole history: `--top-k 40` and
//    `--recall-pool 200`, since no oracle history has more than 36 rounds or 72
//    messages (measured on the S file's evidence sessions), so recall returns
//    every message and the reader is shown every round. Claude Sonnet answers
//    and judges, about 530 subscription calls. The split: of the questions the
//    published run (2026-09-30, official labels) lost to recall, how many the
//    reader gets right once it has every evidence session (the most any recall
//    change could win back); of those it lost with every evidence turn shown,
//    how many it gets right without the 20 to 40 rounds of filler (noise) and
//    how many it still misses (the reader's own ceiling). The same split under
//    the published run's own Claude labels is beside it, judge for judge.
//    The run checks it really was a ceiling: every scored question shown every
//    evidence turn, every round of every history shown.
// 2. The reranker's ceiling. One recall sweep, no model answers: the 50-question
//    multi-session and temporal-reasoning gain set, twice the candidate pool
//    (`--recall-pool 200`), the raw arm against the small cross-encoder and the
//    larger local one (Xenova/bge-reranker-base, 278 M parameters), each reading
//    every candidate. Local only: no text leaves the machine. Bar (`--gain-bar
//    5`): at least 5 more questions shown every evidence turn than the raw arm,
//    net of any it stops showing. Its time will fail the 300 ms budget; this
//    asks only whether the gain exists.
//
// Fetches the oracle file first if it is missing (download.mjs, checked
// against dataset.json); the cross-encoders download on first use. Arms are
// written under bench/results/.progress/ceilings/ while they run, so each
// records a clean tree, and copied into bench/results/ at the end beside
// `<date>-lme-ceilings.json`, the split and the bar. Rerunning the same command
// (same --prefix, by default today's date) reuses what finished and resumes
// what did not. The last line is `RESULT: …`.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { REPO_ROOT, RESULTS_DIR, isoDate, runInfo, writeJson } from "../lib/run-info.mjs";
import { gainBarSentence } from "./arms.mjs";
import { loadInstances } from "./dataset.mjs";
import { DATA_DIR, readManifest } from "./download.mjs";
import { PUBLISHED } from "./event-study.mjs";
import { historyRoundCount } from "./memory.mjs";

export const CEILING_TYPES = ["multi-session", "temporal-reasoning"];
/** Step 1: the published reader settings, with room for every round of an oracle history. */
export const ORACLE_FLAGS = ["--variant", "oracle", "--types", CEILING_TYPES.join(","), "--expand", "--top-k", "40", "--aggregate-top-k", "40", "--recall-pool", "200", "--chain-of-note"];
/** Step 2: the review's sweep (§ 3 item 7), with the small cross-encoder beside the larger one. */
export const SWEEP_ARMS = ["none", "minilm:fp32:all", "bge:fp32:all"];
export const SWEEP_GAIN_BAR = 5;
export const SWEEP_FLAGS = ["--limit", "50", "--types", CEILING_TYPES.join(","), "--expand", "--aggregate-top-k", "40", "--recall-pool", "200", "--gain-bar", String(SWEEP_GAIN_BAR)];

/**
 * Where a published question was lost, by the review's § 2.1 rule: wrong and
 * an abstention question; wrong and not scored for retrieval; wrong with every
 * evidence turn shown (the reader); wrong without (recall). `null` when right.
 */
export function lossOf(q, label) {
  if (label) return null;
  if (q.abstention || q.retrieval?.skipped === "abstention") return "lostAbstention";
  if (q.retrieval?.skipped || !q.retrieval?.shown) return "lostNotScored";
  return q.retrieval.shown.all ? "lostByReader" : "lostToRecall";
}

/**
 * The split, under one set of labels for the published run. Every published
 * question of `types` is placed by `lossOf` (or `right`), and each group says
 * which of its questions the oracle run got right, got wrong, or has no label
 * for (an error, or not run). A published question with no label is listed,
 * not dropped.
 */
export function splitUnder(labels, publishedRows, oracleRows) {
  const groups = Object.fromEntries(["lostToRecall", "lostByReader", "lostAbstention", "lostNotScored", "right"].map((g) => [g, { n: 0, oracleRight: [], oracleWrong: [], notInOracle: [], byType: {} }]));
  const unlabeled = [];
  for (const q of publishedRows) {
    const label = labels.get(q.question_id);
    if (typeof label !== "boolean") {
      unlabeled.push(q.question_id);
      continue;
    }
    const g = groups[lossOf(q, label) ?? "right"];
    const t = (g.byType[q.question_type] ??= { n: 0, oracleRight: 0 });
    g.n += 1;
    t.n += 1;
    const o = oracleRows.get(q.question_id);
    if (!o || o.error || typeof o.label !== "boolean") g.notInOracle.push(q.question_id);
    else if (o.label) {
      g.oracleRight.push(q.question_id);
      t.oracleRight += 1;
    } else g.oracleWrong.push(q.question_id);
  }
  return { groups, unlabeled };
}

/**
 * The reader's ceiling: the published run (its rows carry the Claude labels it
 * was judged with), its official gpt-4o labels, and the oracle run. With
 * `historyRounds` (question id → rounds in its oracle history), it also checks
 * that every round was shown. `status` is `incomplete` when the oracle run is
 * not a clean ceiling: a question errored or is missing, or a scored question
 * was not shown every evidence turn.
 */
export function readerSplit(published, officialRows, oracle, { historyRounds = null, types = CEILING_TYPES } = {}) {
  const publishedRows = published.questions.filter((q) => types.includes(q.question_type));
  const oracleRows = new Map(oracle.questions.map((q) => [q.question_id, q]));
  const official = new Map(officialRows.map((r) => [r.question_id, r.label]));
  const claude = new Map(publishedRows.filter((q) => typeof q.label === "boolean").map((q) => [q.question_id, q.label]));

  const incomplete = [];
  const errored = oracle.questions.filter((q) => q.error).map((q) => q.question_id);
  if (errored.length) incomplete.push(`${errored.length} oracle question(s) errored`);
  const missing = publishedRows.filter((q) => !oracleRows.has(q.question_id)).map((q) => q.question_id);
  if (missing.length) incomplete.push(`${missing.length} of the ${publishedRows.length} questions are not in the oracle run`);
  const scored = oracle.questions.filter((q) => !q.error && q.retrieval?.shown);
  const notShownAll = scored.filter((q) => !q.retrieval.shown.all).map((q) => q.question_id);
  if (notShownAll.length) incomplete.push(`${notShownAll.length} scored oracle question(s) were not shown every evidence turn`);
  let wholeHistory = null;
  if (historyRounds) {
    const ran = oracle.questions.filter((q) => !q.error && Array.isArray(q.shownRounds) && historyRounds.has(q.question_id));
    const partial = ran.filter((q) => q.shownRounds.length < historyRounds.get(q.question_id)).map((q) => q.question_id);
    wholeHistory = { shown: ran.length - partial.length, of: ran.length, partial };
    if (partial.length) incomplete.push(`${partial.length} oracle question(s) were not shown their whole history`);
  }

  const correctByType = {};
  for (const q of oracle.questions) {
    if (q.error || typeof q.label !== "boolean") continue;
    const t = (correctByType[q.question_type] ??= { correct: 0, n: 0 });
    t.n += 1;
    if (q.label) t.correct += 1;
  }
  return {
    status: incomplete.length ? "incomplete" : "complete",
    incomplete,
    coverage: { oracleQuestions: oracle.questions.length, errored, scored: scored.length, shownAll: scored.length - notShownAll.length, notShownAll, wholeHistory },
    oracleCorrectByType: correctByType,
    // The published losses by the official gpt-4o labels; the oracle by the Claude judge.
    official: splitUnder(official, publishedRows, oracleRows),
    // Judge for judge: the published run's own Claude labels against the oracle's.
    claude: splitUnder(claude, publishedRows, oracleRows),
  };
}

/** How a result file's `answerer` or `judge` reads in a sentence: "Claude sonnet", or the command. */
export function modelName(described) {
  if (!described) return "no model";
  if (described.kind === "claude-cli") return `Claude ${described.requestedModel ?? "(default model)"}`;
  return described.requestedModel ?? described.command ?? described.kind;
}

/** One clause on the reader's ceiling, for the RESULT line. `answerer` and `judge` are the oracle run's. */
export function readerSentence(split, { answerer = null, judge = null } = {}) {
  if (split.status === "incomplete") return `the reader's ceiling is incomplete (${split.incomplete.join("; ")}) and concludes nothing`;
  const g = split.official.groups;
  const recall = g.lostToRecall;
  const reader = g.lostByReader;
  const notRun = (x) => (x.notInOracle.length ? `, ${x.notInOracle.length} not run` : "");
  const stillWrong = recall.oracleWrong.length + reader.oracleWrong.length;
  const types = Object.entries(split.oracleCorrectByType).map(([t, c]) => `${t === "temporal-reasoning" ? "temporal" : t} ${c.correct}/${c.n}`).join(", ");
  const who = modelName(answerer) === modelName(judge) ? `${modelName(answerer)} reading and judging` : `${modelName(answerer)} reading, ${modelName(judge)} judging`;
  return (
    `shown every evidence session (oracle; ${who}; ${types}), the reader got ${recall.oracleRight.length} of the ${recall.n} questions the published run lost to recall${notRun(recall)} ` +
    `and ${reader.oracleRight.length} of the ${reader.n} it lost with every evidence turn shown${notRun(reader)} (official labels), so ${stillWrong} of those ${recall.n + reader.n} stay wrong with perfect recall, ` +
    `and it got ${g.right.oracleWrong.length} wrong that the published run got right`
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const { values: args } = parseArgs({
    options: {
      only: { type: "string" },
      prefix: { type: "string" },
      concurrency: { type: "string", default: "4" },
      // For checking the plumbing only: any of these makes it a smoke run, named so.
      limit: { type: "string" },
      "oracle-data": { type: "string" },
      "s-data": { type: "string" },
      "allow-unpinned": { type: "boolean", default: false },
      answerer: { type: "string" },
      judge: { type: "string" },
      "sweep-arm": { type: "string", multiple: true },
    },
  });
  if (args.only !== undefined && !["reader", "rerank"].includes(args.only)) {
    console.error(`--only must be reader or rerank (got ${args.only})`);
    process.exit(1);
  }
  const smoke = args.limit !== undefined || args["allow-unpinned"] || args.answerer !== undefined || args.judge !== undefined || args["sweep-arm"] !== undefined || args["oracle-data"] !== undefined;
  const prefix = args.prefix ?? `${isoDate()}${smoke ? "-smoke" : ""}`;
  const workDir = join(RESULTS_DIR, ".progress", "ceilings");
  mkdirSync(workDir, { recursive: true });
  const node = (script, flags) => spawnSync(process.execPath, [join(REPO_ROOT, script), ...flags], { stdio: "inherit", cwd: REPO_ROOT });
  const why = (r) => (r.error ? r.error.message : `exit ${r.status}`);
  const finalPath = (name) => join(RESULTS_DIR, `${prefix}-${name}.json`);
  let attempted = 0;
  let succeeded = 0;

  /**
   * One step's result file: the copy already in bench/results/, a finished one
   * in the work dir, or a fresh run. A run.mjs result with errors is run again
   * with --resume, which retries just those. Null when it did not finish.
   */
  const step = (name, script, flags, { complete = () => true } = {}) => {
    attempted += 1;
    const final = finalPath(name);
    const work = join(workDir, `${prefix}-${name}.json`);
    for (const [path, label] of [[final, "reusing"], [work, "reusing the finished"]]) {
      if (existsSync(path)) {
        const result = JSON.parse(readFileSync(path, "utf8"));
        if (path === final || complete(result)) {
          console.log(`\n== ${name}: ${label} ${path}`);
          succeeded += 1;
          return { path, result, kept: path === final, complete: true };
        }
      }
    }
    console.log(`\n== ${name}: node ${script} ${flags.join(" ")}`);
    const r = node(script, [...flags, "--resume", "--out", work]);
    if (r.error || r.status !== 0 || !existsSync(work)) {
      console.log(`The ${name} step did not finish (${why(r)}); its progress is kept, so the same command resumes it.`);
      return null;
    }
    const result = JSON.parse(readFileSync(work, "utf8"));
    succeeded += 1;
    // An incomplete result (questions that errored) stays in the work dir, so a rerun resumes it rather than reusing it.
    return { path: work, result, kept: false, complete: complete(result) };
  };

  const info = runInfo();
  const manifest = readManifest();
  const passThrough = [...(args.limit ? ["--limit", args.limit] : []), ...(args["allow-unpinned"] ? ["--allow-unpinned"] : [])];

  // --- 1. the reader's ceiling ------------------------------------------------
  let reader = null;
  let split = null;
  if (args.only !== "rerank") {
    const oracleData = args["oracle-data"] ?? join(DATA_DIR, manifest.files.oracle.path);
    let haveData = existsSync(oracleData);
    if (!haveData && args["oracle-data"] === undefined) {
      console.log("\n== the oracle file is missing: node bench/longmemeval/download.mjs --variant oracle");
      const d = node("bench/longmemeval/download.mjs", ["--variant", "oracle"]);
      haveData = d.status === 0 && existsSync(oracleData);
      if (!haveData) console.log(`The oracle download failed (${why(d)}).`);
    }
    if (!haveData) {
      attempted += 1;
      console.log(`The reader's ceiling cannot run: ${oracleData} is missing.`);
    } else {
      const flags = [...ORACLE_FLAGS, "--concurrency", args.concurrency, ...passThrough, ...(args["oracle-data"] ? ["--data", args["oracle-data"]] : []), ...(args.answerer ? ["--answerer", args.answerer] : []), ...(args.judge ? ["--judge", args.judge] : [])];
      reader = step("lme-ms-tr-oracle", "bench/longmemeval/run.mjs", flags, { complete: (r) => r.summary.errors === 0 });
      if (reader && reader.result.summary.questions === reader.result.summary.errors) {
        console.log(`The oracle run answered none of its ${reader.result.summary.questions} question(s).`);
        succeeded -= 1;
        reader = null;
      }
      if (reader) {
        const historyRounds = new Map(loadInstances(oracleData).filter((x) => CEILING_TYPES.includes(x.question_type)).map((x) => [x.question_id, historyRoundCount(x)]));
        const published = JSON.parse(readFileSync(join(RESULTS_DIR, PUBLISHED.result), "utf8"));
        const officialRows = readFileSync(join(RESULTS_DIR, PUBLISHED.labels), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
        split = readerSplit(published, officialRows, reader.result, { historyRounds });
        // A smoke run covers a few questions, so most of the published ones are "not in the oracle run" by design.
        if (smoke) split.status = "smoke";
      }
    }
  }

  // --- 2. the reranker's ceiling ----------------------------------------------
  let rerank = null;
  if (args.only !== "reader") {
    const arms = (args["sweep-arm"] ?? SWEEP_ARMS).flatMap((a) => ["--arm", a]);
    const flags = [...SWEEP_FLAGS.filter((_, i, all) => !(args.limit && (all[i] === "--limit" || all[i - 1] === "--limit"))), ...arms, ...passThrough, ...(args["s-data"] ? ["--data", args["s-data"]] : [])];
    rerank = step("lme50-gain-bge", "bench/longmemeval/recall-sweep.mjs", flags);
    if (rerank && !rerank.result.gainBar) {
      console.log(`${rerank.path} has no gain bar; it is not this sweep.`);
      succeeded -= 1;
      rerank = null;
    }
  }

  // --- into bench/results/, and the verdicts ----------------------------------
  const files = {};
  for (const [name, s] of [["lme-ms-tr-oracle", reader], ["lme50-gain-bge", rerank]]) {
    if (!s) continue;
    if (!s.complete) {
      files[name] = `not copied, incomplete: ${s.path}`;
      continue;
    }
    const final = finalPath(name);
    if (!s.kept) {
      copyFileSync(s.path, final);
      const hyp = s.path.replace(/\.json$/, ".hypotheses.jsonl");
      if (existsSync(hyp)) copyFileSync(hyp, final.replace(/\.json$/, ".hypotheses.jsonl"));
    }
    files[name] = `${prefix}-${name}.json`;
  }
  const rerankText = rerank ? gainBarSentence(rerank.result.gainBar, { questions: rerank.result.questions.length, againstMsP50: rerank.result.summary[rerank.result.gainBar.against]?.recall?.ms?.p50 ?? null }) : null;
  const clauses = [];
  if (args.only !== "rerank") clauses.push(split ? `Reader: ${readerSentence(split, { answerer: reader.result.answerer, judge: reader.result.judge })}` : "Reader: the oracle run did not finish");
  if (args.only !== "reader") clauses.push(rerank ? `Reranker: ${rerankText}` : "Reranker: the sweep did not finish");
  const head = smoke ? "Smoke run only, not the checks. " : "";
  const sentence =
    succeeded === 0
      ? `RESULT: ${head}No check finished (attempted ${attempted}, succeeded 0); rerun the same command to resume.`
      : `RESULT: ${head}${clauses.join(". ")}.`;
  const summaryPath = finalPath("lme-ceilings");
  // Nothing finished, nothing to record: no summary file that holds no result.
  if (succeeded > 0) writeJson(summaryPath, {
    benchmark: "LongMemEval ceilings: the reader's (oracle) and the reranker's (review 2026-11-17, § 3 items 5 and 7)",
    date: new Date().toISOString(),
    ...info,
    smoke,
    files,
    reader: split
      ? { flags: ORACLE_FLAGS.join(" "), published: PUBLISHED, answerer: modelName(reader.result.answerer), judge: modelName(reader.result.judge), meanPromptChars: reader.result.summary.meanPromptChars, split }
      : { finished: false },
    rerank: rerank ? { flags: [...SWEEP_FLAGS, ...(args["sweep-arm"] ?? SWEEP_ARMS).flatMap((a) => ["--arm", a])].join(" "), gainBar: rerank.result.gainBar, shown: Object.fromEntries(Object.entries(rerank.result.summary).map(([k, v]) => [k, { allEvidence: v.shown?.allEvidence ?? null, recallMs: v.recall?.ms ?? null, approxTokensP50: v.readerContext?.approxTokens?.p50 ?? null }])) } : { finished: false },
    steps: { attempted, succeeded },
    result: sentence.replace(/^RESULT: /, ""),
  });
  if (succeeded > 0) console.log(`\nWrote ${summaryPath}`);
  console.log(`Steps attempted ${attempted}, succeeded ${succeeded}.`);
  console.log(sentence);
  process.exitCode = succeeded === attempted && (!split || split.status !== "incomplete") ? 0 : 1;
}
