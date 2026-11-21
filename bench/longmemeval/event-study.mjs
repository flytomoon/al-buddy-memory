#!/usr/bin/env node
// Usage: npm run build && node bench/longmemeval/event-study.mjs [--retrieval-only]
//
// The write-time event study of the 2026-11-17 review (§ 3 item 2, § 4.3), as
// paired arms under the published settings: the 266 multi-session and
// temporal-reasoning questions, `--expand --aggregate-top-k 40
// --chain-of-note`, the same reader limits (20 rounds, 40 when counting), one
// commit, one dataset file. The only difference between the arms is
// `--extract-events`.
//
// 1. Retrieval, no reader calls: a base arm and an events arm. The bar: of the
//    17 questions the published run (2026-09-30, official labels) lost to
//    recall, at least 6 newly shown every evidence turn; and none of the
//    questions the paired base shows every evidence turn of stops being shown
//    it. Also reported against the published run's 223.
// 2. Only if the bar passes (and without --retrieval-only): the answered pair,
//    Claude Sonnet reading and judging both arms, compared question by question.
//    The official gpt-4o re-grade spends OpenAI money and is not run here.
//
// Arms are written under bench/results/.progress/event-study/ while they run,
// so each arm records a clean tree, and are copied into the results folder
// (RESULTS_DIR, see bench/README.md) with the
// study's summary at the end. Rerunning the same command reuses finished arms,
// resumes a partial one and the extraction cache, and retries failed sessions.
// With --wait-on-limit N, an arm a usage limit stopped is restarted after N
// minutes, at most MAX_LIMIT_WAITS times over the whole study; without it the
// study stops at the first limit and the same command resumes it.
// The last line is `RESULT: …`.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { PROGRESS_DIR, REPO_ROOT, RESULTS_DIR, findResult, isoDate, resultPath, runInfo, writeJson } from "../lib/run-info.mjs";
import { LIMIT_EXIT_CODE } from "./answerers.mjs";
import { digest, evidencePairs, pairwise, report } from "./compare.mjs";

export const STUDY_TYPES = ["multi-session", "temporal-reasoning"];
/** The published run's settings (2026-09-30-lme-full-fast), as run.mjs flags. */
export const STUDY_FLAGS = ["--types", STUDY_TYPES.join(","), "--expand", "--aggregate-top-k", "40", "--chain-of-note"];
export const PUBLISHED = {
  result: "2026-09-30-lme-full-fast.json",
  labels: "2026-09-30-lme-full-fast.hypotheses.eval-gpt-4o-2024-08-06.jsonl",
};
/**
 * The published run and its official labels. The labels are in the private
 * results history, not in bench/results here; set BENCH_RESULTS_DIR to a copy
 * when that repo is not beside this one. Throws, naming where it looked, when
 * either file is missing.
 */
export function readPublished() {
  const files = {};
  for (const [key, name] of Object.entries(PUBLISHED)) {
    const { path, searched } = findResult(name);
    if (!path) throw new Error(`${name} is not in ${searched.join(", ")}; set BENCH_RESULTS_DIR to the folder that holds it`);
    files[key] = path;
  }
  return {
    result: JSON.parse(readFileSync(files.result, "utf8")),
    labels: readFileSync(files.labels, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)),
  };
}
export const BAR = { minGained: 6, maxLost: 0 };
/** More failed session extractions than this share makes the study incomplete, not a result. */
export const MAX_FAILED_SESSION_SHARE = 0.01;
/** With --wait-on-limit, the most usage-limit waits over the whole study (a day at 60 minutes). */
export const MAX_LIMIT_WAITS = 24;

/**
 * What to do when an arm's run.mjs exits with `status`: "done" (0), "wait" (a usage
 * limit stopped it, waiting is on and waits are left), or "stop" (any other
 * failure, a limit with waiting off, or no waits left). Only a limit is waited
 * out: a run that failed for another reason would fail the same way again.
 */
export function armExitAction(status, { waitMinutes = 0, waits = 0, maxWaits = MAX_LIMIT_WAITS } = {}) {
  if (status === 0) return "done";
  if (status === LIMIT_EXIT_CODE && waitMinutes > 0 && waits < maxWaits) return "wait";
  return "stop";
}

/**
 * From the published run and its official labels, over `types`: the questions
 * lost to recall (answered wrong and not shown every evidence turn), the ones
 * shown every evidence turn, and the official count right per type.
 */
export function publishedSets(result, labelRows, types = STUDY_TYPES) {
  const labels = new Map(labelRows.map((r) => [r.question_id, r.label]));
  const lostToRecall = [];
  const shownAll = [];
  const correctByType = {};
  for (const q of result.questions) {
    if (!types.includes(q.question_type)) continue;
    const c = (correctByType[q.question_type] ??= { correct: 0, n: 0 });
    c.n += 1;
    if (labels.get(q.question_id) === true) c.correct += 1;
    if (q.retrieval?.skipped || !q.retrieval?.shown) continue;
    if (q.retrieval.shown.all) shownAll.push(q.question_id);
    else if (labels.get(q.question_id) === false) lostToRecall.push({ id: q.question_id, type: q.question_type });
  }
  return { lostToRecall, shownAll, correctByType };
}

/** Why the two arms are not a pair, or [] when they are. */
export function pairProblems(base, events) {
  const problems = [];
  if (base.commit !== events.commit) problems.push(`commits differ (${base.commit} vs ${events.commit})`);
  if (base.dataset?.sha256 !== events.dataset?.sha256) problems.push("dataset files differ");
  const ids = (r) => r.questions.map((q) => q.question_id).sort().join(",");
  if (ids(base) !== ids(events)) problems.push("the arms ran different questions");
  const same = (s) => JSON.stringify({ ...s, ingestion: undefined, eventExtraction: undefined, concurrency: undefined });
  if (same(base.settings) !== same(events.settings)) problems.push("settings differ beyond --extract-events");
  if (events.settings?.eventExtraction == null) problems.push("the events arm did not extract events");
  if (base.settings?.eventExtraction != null) problems.push("the base arm extracted events");
  return problems;
}

/** Shown-every-evidence-turn and evidence turns found, per type, for one arm's digest. */
function evidenceByType(d) {
  const out = {};
  for (const [, e] of d.evidence) {
    const t = (out[e.type] ??= { scored: 0, all: 0, found: 0, evidence: 0 });
    t.scored += 1;
    t.all += e.all ? 1 : 0;
    t.found += e.found;
    t.evidence += e.evidence;
  }
  return out;
}

/**
 * The retrieval verdict: `pass`, `fail`, or `incomplete` (with reasons) when
 * the arms are not a clean pair, a question errored, or too many sessions
 * failed extraction for the comparison to mean anything.
 */
export function retrievalVerdict(baseResult, eventsResult, published, { smoke = false } = {}) {
  const base = digest(baseResult, "base");
  const events = digest(eventsResult, "events");
  const pairs = evidencePairs(base, events);
  const incomplete = pairProblems(baseResult, eventsResult);
  for (const [name, r] of [["base", baseResult], ["events", eventsResult]]) if (r.summary.errors) incomplete.push(`${r.summary.errors} question(s) errored in the ${name} arm`);
  const x = eventsResult.eventExtraction;
  if (!x) incomplete.push("the events arm recorded no extraction pass");
  else if (x.sessions > 0 && x.failed.length / x.sessions > MAX_FAILED_SESSION_SHARE) incomplete.push(`${x.failed.length} of ${x.sessions} sessions failed extraction (over ${MAX_FAILED_SESSION_SHARE * 100}%)`);
  const gained = new Set(pairs.gained);
  const gainSet = published.lostToRecall.map(({ id, type }) => {
    const b = base.evidence.get(id);
    const e = events.evidence.get(id);
    return { id, type, base: b ? `${b.found}/${b.evidence}` : null, events: e ? `${e.found}/${e.evidence}` : null, newlyShownAll: gained.has(id) };
  });
  const unpaired = gainSet.filter((g) => g.base === null || g.events === null).map((g) => g.id);
  if (unpaired.length && !smoke) incomplete.push(`${unpaired.length} of the ${gainSet.length} lost-to-recall questions are missing from an arm`);
  const gainedCount = gainSet.filter((g) => g.newlyShownAll).length;
  const breakSet = [...base.evidence].filter(([, e]) => e.all).length;
  const publishedBroken = published.shownAll.filter((id) => events.evidence.get(id) && !events.evidence.get(id).all);
  const passed = gainedCount >= BAR.minGained && pairs.lost.length <= BAR.maxLost;
  return {
    status: smoke ? "smoke" : incomplete.length ? "incomplete" : passed ? "pass" : "fail",
    incomplete,
    bar: { ...BAR, gained: gainedCount, of: gainSet.length, lost: pairs.lost.length, ofShownAllInBase: breakSet },
    gainSet,
    lost: pairs.lost,
    fewerTurns: pairs.fewer,
    gainedOutsideTheSet: pairs.gained.filter((id) => !gainSet.some((g) => g.id === id)),
    againstPublished: { shownAll: published.shownAll.length, shownAllInBase: published.shownAll.filter((id) => base.evidence.get(id)?.all).length, noLongerShownAllWithEvents: publishedBroken },
    byType: { base: evidenceByType(base), events: evidenceByType(events) },
  };
}

/** Answer accuracy per type for both answered arms, and the paired fixed/broken. */
export function answeredSummary(baseResult, eventsResult) {
  const base = digest(baseResult, "base-answered");
  const events = digest(eventsResult, "events-answered");
  const counts = (d) => Object.fromEntries(Object.entries(d.qa.byType).map(([t, v]) => [t, { correct: Math.round(v.accuracy * v.n), n: v.n }]));
  const p = pairwise(base, events);
  return { judge: base.judge, base: counts(base), events: counts(events), fixed: p.fixed, broken: p.broken, byType: p.byType, both: p.both, promptChars: { base: baseResult.summary.meanPromptChars, events: eventsResult.summary.meanPromptChars } };
}

const fmtType = (t) => (t === "multi-session" ? "multi-session" : t === "temporal-reasoning" ? "temporal" : t);

/** The closing sentence. */
export function resultSentence(verdict, answered, { arms }) {
  if (verdict.status === "incomplete") return `RESULT: The event study is incomplete (${verdict.incomplete.join("; ")}); it concludes nothing.`;
  const types = Object.keys(verdict.byType.base);
  const perType = types.map((t) => `${fmtType(t)} ${verdict.byType.base[t].all}→${verdict.byType.events[t]?.all ?? "—"} of ${verdict.byType.base[t].scored}`).join(", ");
  const head = `the events arm newly showed every evidence turn for ${verdict.bar.gained} of the ${verdict.bar.of} lost-to-recall questions and stopped showing it for ${verdict.bar.lost} of the ${verdict.bar.ofShownAllInBase} the base arm showed in full (all evidence shown: ${perType})`;
  if (verdict.status === "smoke") return `RESULT: Smoke run only, not the study (${arms} arms on a subset): ${head}.`;
  const bar = `the bar (at least ${BAR.minGained}, and ${BAR.maxLost}) ${verdict.status === "pass" ? "passed" : "failed"}`;
  if (!answered) return `RESULT: Over ${types.length} types, ${head}; ${bar}${verdict.status === "pass" ? "; the answered pair was not run" : ", so the answered pair was not run"}.`;
  const acc = Object.keys(answered.base).map((t) => `${fmtType(t)} ${answered.base[t].correct}→${answered.events[t]?.correct ?? "—"} of ${answered.base[t].n}`).join(", ");
  return `RESULT: ${head[0].toUpperCase()}${head.slice(1)}; ${bar}; answered with the Claude judge, ${acc} (fixed ${answered.fixed}, broke ${answered.broken}).`;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const { values: args } = parseArgs({
    options: {
      "retrieval-only": { type: "boolean", default: false },
      prefix: { type: "string" },
      data: { type: "string" },
      limit: { type: "string" },
      retrieval: { type: "string" },
      concurrency: { type: "string", default: "4" },
      "events-model": { type: "string" },
      "events-extractor": { type: "string" },
      "wait-on-limit": { type: "string", default: "0" },
    },
  });
  const waitMinutes = Number(args["wait-on-limit"]);
  if (!Number.isFinite(waitMinutes) || waitMinutes < 0) {
    console.error(`--wait-on-limit must be a number of minutes >= 0 (got ${args["wait-on-limit"]})`);
    process.exit(1);
  }
  let waits = 0;
  // --limit and --retrieval are for checking the plumbing: the result says it is a smoke run.
  const smoke = args.limit !== undefined || args.retrieval !== undefined;
  const prefix = args.prefix ?? `${isoDate()}-lme-ms-tr${smoke ? "-smoke" : ""}`;
  const workDir = join(PROGRESS_DIR, "event-study");
  mkdirSync(workDir, { recursive: true });
  const cache = join(PROGRESS_DIR, "events.cache.jsonl");
  const common = [
    ...STUDY_FLAGS,
    "--concurrency", args.concurrency,
    ...(args.data ? ["--data", args.data] : []),
    ...(args.limit ? ["--limit", args.limit] : []),
    ...(args.retrieval ? ["--retrieval", args.retrieval] : []),
  ];
  const eventFlags = ["--extract-events", "--events-cache", cache, ...(args["events-model"] ? ["--events-model", args["events-model"]] : []), ...(args["events-extractor"] ? ["--events-extractor", args["events-extractor"]] : [])];
  let attempted = 0;
  let succeeded = 0;
  const finish = (sentence, code) => {
    console.log(`Arms attempted ${attempted}, succeeded ${succeeded}.`);
    console.log(sentence);
    process.exitCode = code;
  };
  /** Run (or reuse) one arm; null when it did not finish. */
  const arm = (name, flags) => {
    attempted += 1;
    const out = join(workDir, `${prefix}-${name}.json`);
    if (existsSync(out)) console.log(`\n== ${name}: reusing ${out}`);
    else {
      for (;;) {
        console.log(`\n== ${name}: node bench/longmemeval/run.mjs ${[...common, ...flags].join(" ")}`);
        const r = spawnSync(process.execPath, [join(REPO_ROOT, "bench/longmemeval/run.mjs"), ...common, ...flags, "--resume", "--out", out], { stdio: "inherit", cwd: REPO_ROOT });
        const action = r.error ? "stop" : armExitAction(r.status, { waitMinutes, waits });
        if (action === "wait") {
          waits += 1;
          console.log(`The ${name} arm stopped at a usage limit; waiting ${waitMinutes} min before resuming it (wait ${waits} of ${MAX_LIMIT_WAITS}).`);
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMinutes * 60_000);
          continue;
        }
        if (action === "stop" || !existsSync(out)) {
          const why = r.error ? r.error.message : r.status === LIMIT_EXIT_CODE ? `a usage limit${waitMinutes > 0 ? `, after ${waits} wait(s)` : "; --wait-on-limit waits one out"}` : `exit ${r.status}`;
          console.log(`The ${name} arm did not finish (${why}); its progress is kept, so the same command resumes it.`);
          return null;
        }
        break;
      }
    }
    const result = JSON.parse(readFileSync(out, "utf8"));
    if (result.summary.questions === result.summary.errors) {
      console.log(`The ${name} arm answered none of its ${result.summary.questions} question(s).`);
      return null;
    }
    succeeded += 1;
    return { out, result };
  };

  const info = runInfo();
  let published = null;
  let missing = null;
  try {
    const p = readPublished();
    published = publishedSets(p.result, p.labels);
  } catch (err) {
    missing = err.message;
  }
  const base = published && arm("base", ["--answerer", "none", "--judge", "none"]);
  const events = base && arm("events", ["--answerer", "none", "--judge", "none", ...eventFlags]);
  if (!published) finish(`RESULT: The event study did not start: ${missing}.`, 1);
  else if (!base || !events) finish(`RESULT: The event study stopped before both retrieval arms finished (attempted ${attempted}, succeeded ${succeeded}); rerun the same command to resume.`, 1);
  else {
    const verdict = retrievalVerdict(base.result, events.result, published, { smoke });
    console.log(`\n${report([digest(base.result, "base"), digest(events.result, "events")])}`);
    let answered = null;
    let answeredArms = null;
    if (verdict.status === "pass" && !args["retrieval-only"]) {
      const a = arm("base-answered", []);
      const b = a && arm("events-answered", eventFlags);
      if (a && b) {
        answered = answeredSummary(a.result, b.result);
        answeredArms = [a, b];
        console.log(`\n${report([digest(a.result, "base-answered"), digest(b.result, "events-answered")])}`);
      }
    }
    // Into bench/results/ under names that never overwrite an earlier study.
    const date = prefix;
    const kept = {};
    for (const [name, a] of [["base", base], ["events", events], ...(answeredArms ? [["base-answered", answeredArms[0]], ["events-answered", answeredArms[1]]] : [])]) {
      const dest = resultPath(RESULTS_DIR, date, name);
      copyFileSync(a.out, dest);
      const hyp = a.out.replace(/\.json$/, ".hypotheses.jsonl");
      if (existsSync(hyp)) copyFileSync(hyp, dest.replace(/\.json$/, ".hypotheses.jsonl"));
      kept[name] = basename(dest);
    }
    const summaryPath = resultPath(RESULTS_DIR, date, "event-study");
    const answeredMissing = verdict.status === "pass" && !args["retrieval-only"] && !answered;
    const sentence = answeredMissing
      ? `RESULT: The retrieval bar passed (${verdict.bar.gained} of ${verdict.bar.of} newly shown, ${verdict.bar.lost} lost) but the answered pair did not finish (attempted ${attempted} arms, succeeded ${succeeded}); rerun the same command to resume it.`
      : resultSentence(verdict, answered, { arms: succeeded });
    writeJson(summaryPath, {
      benchmark: "LongMemEval write-time event study (review 2026-11-17, § 3 item 2)",
      date: new Date().toISOString(),
      ...info,
      smoke,
      arms: kept,
      settings: { flags: STUDY_FLAGS.join(" "), base: base.result.settings, eventExtraction: events.result.settings.eventExtraction },
      published: { files: PUBLISHED, lostToRecall: published.lostToRecall.length, shownAll: published.shownAll.length, officialCorrectByType: published.correctByType },
      eventExtraction: events.result.eventExtraction,
      retrieval: verdict,
      answered,
      officialRegrade: "not run: it calls gpt-4o over the OpenAI API (review § 3 item 4's decision)",
      result: sentence.replace(/^RESULT: /, ""),
    });
    console.log(`\nWrote ${summaryPath}`);
    finish(sentence, verdict.status === "incomplete" || answeredMissing ? 1 : 0);
  }
}
