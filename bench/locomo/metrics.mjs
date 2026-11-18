/**
 * What a LoCoMo result reports, from its rows.
 *
 *   - Accuracy on the 1,540 scored questions (categories 1-4), overall and per
 *     category with its size, against the published key and, beside it,
 *     against the audit's corrected key.
 *   - The 446 adversarial questions (category 5) on their own: by the
 *     abstention judge and by LoCoMo's keyword rule. Never in the overall.
 *   - Retrieval, no model: whether the turns the dataset cites as evidence are
 *     in what recall returned (any@k, all@k) and in what the reader was shown.
 *   - Recall time, reader tokens per question, model ids and usage.
 */
import { round4 } from "../lib/run-info.mjs";
import { percentile, summarizeRecallTime } from "../longmemeval/metrics.mjs";
import { ADVERSARIAL, CATEGORY_SIZES, SCORED_CATEGORIES } from "./dataset.mjs";

export const RETRIEVAL_KS = [5, 10, 20, 50];

const mean = (xs) => (xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length);
const r4 = (x) => (x === null ? null : round4(x));

/**
 * Retrieval for one question: `ranked` is recall's turns (dia_ids, best
 * first), `shown` the ones the reader saw. A question with no evidence turn
 * the conversation holds is skipped, with the reason.
 */
export function retrievalFor(ranked, shown, evidence) {
  if (evidence.length === 0) return { skipped: "no-evidence" };
  const at = {};
  for (const k of RETRIEVAL_KS) {
    const top = new Set(ranked.slice(0, k));
    at[`any@${k}`] = evidence.some((id) => top.has(id)) ? 1 : 0;
    at[`all@${k}`] = evidence.every((id) => top.has(id)) ? 1 : 0;
  }
  const seen = new Set(shown);
  const found = evidence.filter((id) => seen.has(id)).length;
  return { skipped: null, at, shown: { turns: shown.length, evidence: evidence.length, found, all: found === evidence.length ? 1 : 0 } };
}

function retrievalSummary(rows) {
  const counted = rows.filter((r) => r.retrieval && !r.retrieval.skipped);
  const at = {};
  for (const k of RETRIEVAL_KS) for (const m of ["any", "all"]) at[`${m}@${k}`] = r4(mean(counted.map((r) => r.retrieval.at[`${m}@${k}`])));
  const evidence = counted.reduce((a, r) => a + r.retrieval.shown.evidence, 0);
  return {
    n: counted.length,
    skipped: rows.length - counted.length,
    at,
    shownAllEvidence: r4(mean(counted.map((r) => r.retrieval.shown.all))),
    shownEvidenceTurns: evidence ? round4(counted.reduce((a, r) => a + r.retrieval.shown.found, 0) / evidence) : null,
    meanShownTurns: r4(mean(counted.map((r) => r.retrieval.shown.turns))),
  };
}

/** Accuracy over the rows that have a label; `n` is how many did. */
function accuracy(rows, field) {
  const judged = rows.filter((r) => typeof r[field] === "boolean");
  return { n: judged.length, correct: judged.filter((r) => r[field]).length, accuracy: r4(mean(judged.map((r) => (r[field] ? 1 : 0)))) };
}

/**
 * The scoreboard. `rows` without `error`. Scored = categories 1-4; their
 * accuracy against the published key (`label`) and the corrected one
 * (`labelCorrected`), each with its own count, per category keyed by number
 * with the category's full size beside it.
 */
export function summarizeAnswers(rows) {
  const scored = rows.filter((r) => !r.adversarial);
  const adversarial = rows.filter((r) => r.adversarial);
  const byCategory = {};
  for (const c of SCORED_CATEGORIES) {
    const xs = scored.filter((r) => r.category === c);
    if (xs.length) byCategory[c] = { size: CATEGORY_SIZES[c], published: accuracy(xs, "label"), corrected: accuracy(xs, "labelCorrected") };
  }
  const changed = scored.filter((r) => r.correctedAnswer !== null && r.correctedAnswer !== undefined);
  const flips = changed.filter((r) => typeof r.label === "boolean" && typeof r.labelCorrected === "boolean");
  return {
    scored: {
      questions: scored.length,
      published: accuracy(scored, "label"),
      corrected: accuracy(scored, "labelCorrected"),
      byCategory,
      keyChanged: { questions: changed.length, wrongToCorrect: flips.filter((r) => !r.label && r.labelCorrected).length, correctToWrong: flips.filter((r) => r.label && !r.labelCorrected).length },
    },
    adversarial: {
      category: ADVERSARIAL,
      size: CATEGORY_SIZES[ADVERSARIAL],
      questions: adversarial.length,
      abstentionJudge: accuracy(adversarial, "label"),
      keywordRule: accuracy(adversarial, "keywordRule"),
    },
  };
}

function sumUsage(rows, field) {
  const total = {};
  for (const r of rows) for (const [k, v] of Object.entries(r[field] ?? {})) if (typeof v === "number") total[k] = (total[k] ?? 0) + v;
  return total;
}

function modelCounts(rows, fields) {
  const counts = {};
  for (const r of rows) for (const f of fields) for (const id of r[f] ?? []) counts[id] = (counts[id] ?? 0) + 1;
  return counts;
}

/**
 * The tokens the reader was handed for one answer, from the CLI's usage:
 * input plus cache writes and reads (the prompt, wherever it was billed).
 * Null when the answerer reports no usage (a shell command).
 */
export function readerInputTokens(usage) {
  if (!usage || typeof usage.input_tokens !== "number") return null;
  return usage.input_tokens + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
}

const statsOf = (xs) => (xs.length === 0 ? null : { mean: Math.round(mean(xs)), p50: percentile(xs, 0.5), p95: percentile(xs, 0.95), max: Math.max(...xs) });

/**
 * The scoreboard as rows, for the summary file: categories 1-4 by number with
 * each one's size, judged count and accuracy against the published and the
 * corrected key; the four together; and category 5 on its own row, marked as
 * outside the overall, by the abstention judge and the keyword rule.
 */
export function scoreTable(summary) {
  const sc = summary.scored;
  const row = (category, size, v) => ({ category, size, judged: v.published.n, published: v.published.accuracy, corrected: v.corrected.accuracy, correctPublished: v.published.correct, correctCorrected: v.corrected.correct });
  const adv = summary.adversarial;
  return [
    ...SCORED_CATEGORIES.filter((c) => sc.byCategory[c]).map((c) => row(c, CATEGORY_SIZES[c], sc.byCategory[c])),
    row("1-4", SCORED_CATEGORIES.reduce((a, c) => a + CATEGORY_SIZES[c], 0), sc),
    {
      category: ADVERSARIAL,
      size: adv.size,
      inOverall: false,
      judged: adv.abstentionJudge.n,
      abstentionJudge: adv.abstentionJudge.accuracy,
      keywordRule: adv.keywordRule.accuracy,
      keywordRuleN: adv.keywordRule.n,
    },
  ];
}

/**
 * The support check (`--support-check`), per category: how many questions it
 * applied to (they name one speaker) and how many it fired on. Null when no
 * row ran it.
 */
export function summarizeSupportCheck(rows) {
  const ran = rows.filter((r) => r.supportCheck);
  if (ran.length === 0) return null;
  const byCategory = {};
  for (const c of [...SCORED_CATEGORIES, ADVERSARIAL]) {
    const xs = ran.filter((r) => r.category === c);
    if (xs.length) byCategory[c] = { questions: xs.length, checked: xs.filter((r) => r.supportCheck.checked).length, fired: xs.filter((r) => r.supportCheck.fired).length };
  }
  return { questions: ran.length, fired: ran.filter((r) => r.supportCheck.fired).length, byCategory };
}

/** The headline number of one category in a summary: accuracy against the published and the corrected key (1-4) or the abstention judge's (5); every evidence turn shown; how many judged. */
function categoryNumbers(summary, c) {
  const retrieval = summary.retrieval?.byCategory?.[c] ?? null;
  const shownAllEvidence = retrieval?.shownAllEvidence ?? null;
  if (Number(c) === ADVERSARIAL) {
    const a = summary.adversarial?.abstentionJudge;
    return a && a.n ? { judged: a.n, accuracy: a.accuracy, corrected: null, shownAllEvidence } : retrieval ? { judged: 0, accuracy: null, corrected: null, shownAllEvidence } : null;
  }
  const s = summary.scored?.byCategory?.[c];
  if (!s && !retrieval) return null;
  return { judged: s?.published.n ?? 0, accuracy: s?.published.accuracy ?? null, corrected: s?.corrected.accuracy ?? null, shownAllEvidence };
}

/** How many points a category may fall before `compareToBaseline` calls it a regression. */
export const REGRESSION_POINTS = 1;

/**
 * This run beside an earlier one (its `summary`), category by category, for
 * the categories this run has: accuracy (5: the abstention judge's), the
 * corrected key's, every evidence turn shown, each with the change in points;
 * `regressed` when accuracy or the corrected key fell by more than
 * REGRESSION_POINTS. And recall p50, this run's and the earlier one's (over
 * whatever questions each ran).
 */
export function compareToBaseline(summary, baseline) {
  const pts = (a, b) => (typeof a === "number" && typeof b === "number" ? Math.round((a - b) * 1000) / 10 : null);
  const categories = [];
  for (const c of [...SCORED_CATEGORIES, ADVERSARIAL].sort((a, b) => a - b)) {
    const after = categoryNumbers(summary, c);
    if (!after) continue;
    const before = categoryNumbers(baseline, c);
    const change = { accuracy: pts(after.accuracy, before?.accuracy), corrected: pts(after.corrected, before?.corrected), shownAllEvidence: pts(after.shownAllEvidence, before?.shownAllEvidence) };
    categories.push({ category: c, before, after, change, regressed: [change.accuracy, change.corrected].some((x) => x !== null && x < -REGRESSION_POINTS) });
  }
  return { categories, recallP50Ms: { before: baseline.recall?.ms?.p50 ?? null, after: summary.recall?.ms?.p50 ?? null } };
}

/** Everything a results file reports about a set of rows. */
export function summarize(rows) {
  const ok = rows.filter((r) => !r.error);
  const answered = ok.filter((r) => typeof r.hypothesis === "string");
  const tokens = answered.map((r) => r.readerInputTokens).filter((x) => typeof x === "number");
  const retrievalBy = {};
  for (const c of [...SCORED_CATEGORIES, ADVERSARIAL]) {
    const xs = ok.filter((r) => r.category === c);
    if (xs.length) retrievalBy[c] = { size: CATEGORY_SIZES[c], ...retrievalSummary(xs) };
  }
  const cost = ok.reduce((a, r) => a + (r.answerNotionalCostUsd ?? 0) + (r.judgeNotionalCostUsd ?? 0) + (r.judgeCorrectedNotionalCostUsd ?? 0), 0);
  return {
    questions: rows.length,
    errors: rows.length - ok.length,
    answered: answered.length,
    ...summarizeAnswers(ok),
    retrieval: { scored: retrievalSummary(ok.filter((r) => !r.adversarial)), adversarial: retrievalSummary(ok.filter((r) => r.adversarial)), byCategory: retrievalBy },
    recall: summarizeRecallTime(ok),
    ...(ok.some((r) => r.supportCheck) ? { supportCheck: summarizeSupportCheck(ok) } : {}),
    reader: {
      inputTokensPerQuestion: statsOf(tokens),
      inputTokensReported: tokens.length,
      promptCharsPerQuestion: statsOf(answered.map((r) => r.promptChars)),
      shownTurnsPerQuestion: statsOf(ok.map((r) => r.shownTurns?.length ?? 0)),
    },
    calls: { answer: answered.length, judge: ok.filter((r) => typeof r.judgeResponse === "string").length, judgeCorrected: ok.filter((r) => typeof r.judgeCorrectedResponse === "string").length },
    models: { answer: modelCounts(ok, ["answerModels"]), judge: modelCounts(ok, ["judgeModels", "judgeCorrectedModels"]) },
    usage: { answer: sumUsage(ok, "answerUsage"), judge: sumUsage(ok, "judgeUsage"), judgeCorrected: sumUsage(ok, "judgeCorrectedUsage") },
    notionalCostUsd: Math.round(cost * 100) / 100,
  };
}
