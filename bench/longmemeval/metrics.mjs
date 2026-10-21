/**
 * The official LongMemEval metrics, ported line for line.
 *
 *   - Retrieval: src/retrieval/eval_utils.py (`evaluate_retrieval`,
 *     `evaluate_retrieval_turn2session`, `ndcg`, `dcg`) and the averaging in
 *     src/retrieval/run_retrieval.py (k in 1, 3, 5, 10, 30, 50; abstention
 *     questions and questions with no user-side evidence skipped).
 *   - QA: src/evaluation/print_qa_metrics.py (accuracy per question type, the
 *     task-averaged accuracy, overall accuracy, abstention accuracy).
 *
 * Commit 9e0b455f4ef0e2ab8f2e582289761153549043fc. The official code ranks the
 * whole corpus; a memory recall returns its best candidates, so here a ranking
 * is a list of corpus ids, best first, and anything it does not list was not
 * retrieved.
 */
import { round4 } from "../lib/run-info.mjs";
import { QUESTION_TYPES, isAbstention } from "./dataset.mjs";

export const RETRIEVAL_KS = [1, 3, 5, 10, 30, 50];

/**
 * DCG as the official code computes it: `r[0] + sum(r[1:] / log2(arange(2, n + 1)))`.
 * The first two positions both count in full — not the textbook discount, and
 * kept because it is the published metric.
 */
export function dcg(relevances, k) {
  const r = relevances.slice(0, k);
  if (r.length === 0) return 0;
  let sum = r[0];
  for (let i = 1; i < r.length; i += 1) sum += r[i] / Math.log2(i + 1);
  return sum;
}

export function ndcg(ranked, correct, corpus, k) {
  const isCorrect = new Set(correct);
  const ideal = corpus.map((d) => (isCorrect.has(d) ? 1 : 0)).sort((a, b) => b - a);
  const idealDcg = dcg(ideal, k);
  if (idealDcg === 0) return 0;
  return dcg(ranked.slice(0, k).map((d) => (isCorrect.has(d) ? 1 : 0)), k) / idealDcg;
}

/** recall_any@k, recall_all@k and ndcg_any@k for one question. */
export function evaluateRetrieval(ranked, correct, corpus, k) {
  const top = new Set(ranked.slice(0, k));
  return {
    recallAny: correct.some((d) => top.has(d)) ? 1 : 0,
    recallAll: correct.every((d) => top.has(d)) ? 1 : 0,
    ndcgAny: ndcg(ranked, correct, corpus, k),
  };
}

const stripTurn = (id) => id.split("_").slice(0, -1).join("_");

/**
 * Session-level metrics from a turn-level ranking: ids lose their turn suffix,
 * and k grows until the top k turns cover k distinct sessions.
 */
export function evaluateRetrievalTurn2Session(ranked, correct, corpus, k) {
  const sessionsCorrect = [...new Set(correct.map(stripTurn))];
  const sessionsCorpus = corpus.map(stripTurn);
  const sessionsRanked = ranked.map(stripTurn);
  let effectiveK = k;
  let unique = new Set(sessionsRanked.slice(0, effectiveK));
  while (effectiveK <= sessionsCorpus.length && unique.size < k) {
    effectiveK += 1;
    unique = new Set(sessionsRanked.slice(0, effectiveK));
  }
  return evaluateRetrieval(sessionsRanked, sessionsCorrect, sessionsCorpus, effectiveK);
}

/** Every official retrieval metric for one question, at turn and at session level. */
export function retrievalMetrics(ranked, correct, corpus) {
  const out = { turn: {}, session: {} };
  for (const k of RETRIEVAL_KS) {
    const t = evaluateRetrieval(ranked, correct, corpus, k);
    const s = evaluateRetrievalTurn2Session(ranked, correct, corpus, k);
    Object.assign(out.turn, { [`recall_any@${k}`]: t.recallAny, [`recall_all@${k}`]: t.recallAll, [`ndcg_any@${k}`]: t.ndcgAny });
    Object.assign(out.session, { [`recall_any@${k}`]: s.recallAny, [`recall_all@${k}`]: s.recallAll, [`ndcg_any@${k}`]: s.ndcgAny });
  }
  return out;
}

/**
 * Not an official metric: how much of the evidence the reader was actually
 * shown. The official ones cut the ranking at fixed k; the reader sees
 * `shown.length` rounds (more, for a counting question, with an aggregate
 * top-k), and a question that needs every piece of evidence is lost by the one
 * it was not shown.
 */
export function shownEvidence(shown, correct) {
  const seen = new Set(shown);
  const found = correct.filter((id) => seen.has(id)).length;
  return { rounds: shown.length, evidence: correct.length, found, all: found === correct.length ? 1 : 0 };
}

const mean = (xs) => (xs.length === 0 ? NaN : xs.reduce((a, b) => a + b, 0) / xs.length);

/**
 * The averages the official retrieval script prints, over the questions it
 * counts. `rows` are `{ question_id, retrieval: { skipped, metrics } }`. Rows
 * that also carry `retrieval.shown` get the (unofficial) shown-evidence
 * averages beside them, overall and per question type.
 */
export function summarizeRetrieval(rows) {
  const counted = rows.filter((r) => r.retrieval && !r.retrieval.skipped);
  const skipped = { abstention: 0, "no-user-evidence": 0 };
  for (const r of rows) if (r.retrieval?.skipped) skipped[r.retrieval.skipped] = (skipped[r.retrieval.skipped] ?? 0) + 1;
  const averages = { session: {}, turn: {} };
  for (const level of ["session", "turn"]) {
    const names = counted.length ? Object.keys(counted[0].retrieval.metrics[level]) : [];
    for (const name of names) averages[level][name] = round4(mean(counted.map((r) => r.retrieval.metrics[level][name])));
  }
  const withShown = counted.filter((r) => r.retrieval.shown);
  if (withShown.length === 0) return { questions: counted.length, skipped, ...averages };
  const shownSummary = (xs) => ({
    n: xs.length,
    allEvidence: round4(mean(xs.map((r) => r.retrieval.shown.all))),
    evidenceFound: round4(xs.reduce((a, r) => a + r.retrieval.shown.found, 0) / Math.max(1, xs.reduce((a, r) => a + r.retrieval.shown.evidence, 0))),
    meanRounds: round4(mean(xs.map((r) => r.retrieval.shown.rounds))),
  });
  const byType = {};
  for (const t of QUESTION_TYPES) {
    const xs = withShown.filter((r) => r.question_type === t);
    if (xs.length) byType[t] = shownSummary(xs);
  }
  return { questions: counted.length, skipped, ...averages, shown: { ...shownSummary(withShown), byType } };
}

/** The nearest-rank percentile: the smallest value at least `p` of `xs` are at or below. */
export function percentile(xs, p) {
  if (xs.length === 0) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
}

const round1 = (x) => (Number.isFinite(x) ? Math.round(x * 10) / 10 : null);

/** Whether two arms show the reader the same rounds (the prompt lists them by date, so order does not count). */
export function sameRounds(a, b) {
  return [...a].sort().join("\n") === [...b].sort().join("\n");
}

/**
 * Not an official metric: whether a reranker gated on the time window (review
 * 2026-10, change 5) passes its bar against the same recall without it, over
 * a recall sweep's rows (`{ question_id, cues, arms: { [name]: { retrieval,
 * shownRounds, recall } } }`). `arm` is the gated arm, `base` the one without
 * its reranker. It passes when all four hold:
 *
 * - `windowP95`: the recalls of questions that name a period (`cues.windows`)
 *   take at most `budgetMs` at p95 (and there is at least one);
 * - `windowEvidence`: more of those questions newly show every evidence turn
 *   than no longer do;
 * - `otherSameRounds`: every other question shows the same rounds as `base`;
 * - `otherTime`: and its recall is no slower than `toleranceMs` by the median
 *   of the per-question differences. The gate skips the reranker there, so
 *   only noise moves it, either way; faster is noise too, and no harm.
 */
export function windowGateCheck(rows, { arm, base, budgetMs = 300, toleranceMs = 1 }) {
  const named = (r) => (r.cues?.windows?.length ?? 0) > 0;
  const window = rows.filter(named);
  const other = rows.filter((r) => !named(r));
  const allShown = (r, name) => r.arms[name].retrieval.shown?.all;
  const scored = window.filter((r) => allShown(r, arm) !== undefined && allShown(r, base) !== undefined);
  const gained = scored.filter((r) => allShown(r, arm) === 1 && allShown(r, base) === 0).map((r) => r.question_id);
  const lost = scored.filter((r) => allShown(r, arm) === 0 && allShown(r, base) === 1).map((r) => r.question_id);
  const ms = (xs, name) => xs.map((r) => r.arms[name].recall.ms);
  const stats = (xs) => (xs.length === 0 ? null : { p50: round1(percentile(xs, 0.5)), p95: round1(percentile(xs, 0.95)), max: round1(Math.max(...xs)) });
  const windowMs = stats(ms(window, arm));
  const otherSame = other.filter((r) => sameRounds(r.arms[arm].shownRounds, r.arms[base].shownRounds)).length;
  const pairedMs = other.length === 0 ? null : round1(percentile(other.map((r) => r.arms[arm].recall.ms - r.arms[base].recall.ms), 0.5));
  const checks = {
    windowP95: windowMs !== null && windowMs.p95 <= budgetMs,
    windowEvidence: gained.length > lost.length,
    otherSameRounds: otherSame === other.length,
    otherTime: pairedMs === null || pairedMs <= toleranceMs,
  };
  return {
    arm,
    base,
    budgetMs,
    toleranceMs,
    window: {
      n: window.length,
      recallMs: windowMs,
      baseRecallMs: stats(ms(window, base)),
      allEvidence: { arm: scored.filter((r) => allShown(r, arm) === 1).length, base: scored.filter((r) => allShown(r, base) === 1).length, of: scored.length },
      gained,
      lost,
    },
    other: { n: other.length, sameRounds: otherSame, recallMs: stats(ms(other, arm)), baseRecallMs: stats(ms(other, base)), pairedMs },
    checks,
    pass: Object.values(checks).every(Boolean),
  };
}

/**
 * Not an official metric: how long recall took, per question, as every row
 * records it (`recall.ms` by the wall clock, `recall.cpuMs` in CPU time, and
 * `recall.load1`, the machine's 1-minute load average then). Rows from before
 * recall was timed have none, and give `null`.
 */
export function summarizeRecallTime(rows) {
  const timed = rows.filter((r) => typeof r.recall?.ms === "number");
  if (timed.length === 0) return null;
  const stats = (xs) => ({ p50: round1(percentile(xs, 0.5)), p95: round1(percentile(xs, 0.95)), max: round1(Math.max(...xs)), mean: round1(mean(xs)) });
  const loads = timed.map((r) => r.recall.load1).filter((x) => typeof x === "number");
  return {
    n: timed.length,
    ms: stats(timed.map((r) => r.recall.ms)),
    cpuMs: stats(timed.map((r) => r.recall.cpuMs)),
    load1: loads.length ? { mean: round1(mean(loads)), max: round1(Math.max(...loads)) } : null,
  };
}

/**
 * The QA numbers the official metrics script prints. `rows` are
 * `{ question_id, question_type, label }` with `label` true or false; rows with
 * no label (not judged) are left out. The official task average is over all
 * six types; a partial run averages over the types it has and lists the rest.
 */
export function summarizeQa(rows) {
  const judged = rows.filter((r) => typeof r.label === "boolean");
  const byType = {};
  const typeMeans = [];
  for (const t of QUESTION_TYPES) {
    const labels = judged.filter((r) => r.question_type === t).map((r) => (r.label ? 1 : 0));
    if (!labels.length) continue;
    typeMeans.push(mean(labels));
    byType[t] = { accuracy: round4(mean(labels)), n: labels.length };
  }
  const abstention = judged.filter((r) => isAbstention(r.question_id)).map((r) => (r.label ? 1 : 0));
  return {
    questions: judged.length,
    overallAccuracy: round4(mean(judged.map((r) => (r.label ? 1 : 0)))),
    taskAveragedAccuracy: round4(mean(typeMeans)),
    typesMissing: QUESTION_TYPES.filter((t) => !byType[t]),
    abstention: { accuracy: round4(mean(abstention)), n: abstention.length },
    byType,
  };
}
