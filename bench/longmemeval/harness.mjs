/**
 * One LongMemEval question end to end — fresh memory, recall, the official
 * retrieval metrics, the official reader prompt, an answer, the official judge
 * — and a run over many of them.
 */
import { loadavg } from "node:os";

import { corpusOf, isAbstention, parseSessionDate, retrievalSkipReason } from "./dataset.mjs";
import { ingestHistory, recallRounds } from "./memory.mjs";
import { retrievalMetrics, shownEvidence, summarizeQa, summarizeRecallTime, summarizeRetrieval } from "./metrics.mjs";
import { answerPrompt, judgePrompt, judgeLabel } from "./prompts.mjs";
import { UsageLimitError } from "./answerers.mjs";

/**
 * Evaluate one instance. `answerer` and `judge` may be null: without an
 * answerer the row has retrieval metrics only; without a judge it has a
 * hypothesis and no label (judge it later from the hypotheses file).
 *
 * The A/B options, each off by default: `reranker` (the retriever reorders
 * what it finds with a cross-encoder), `expand` (recall reads the question's
 * time and counting cues), `recallPool` (how many memories recall returns,
 * default RECALL_POOL), `aggregateTopK` (how many rounds the reader sees
 * when the question counts across memories, instead of `topK`), and
 * `chainOfNote` (such a question gets the chain-of-note reader). Whether a
 * question "counts across memories" is the library's `analyzeQuery`, recorded
 * in every row as `cues`. `rerankDepth` bounds how many candidates the
 * reranker reads (default all of them). `queryEmbedder` embeds the question
 * (default `embedder`; see `ingestHistory`).
 *
 * Every row records `recall`: how long `HybridRetriever.recall` alone took
 * (`ms`, `cpuMs`) and the machine's 1-minute load average just after
 * (`load1`). Building the memory and recalling from it run inside
 * `exclusive`, which a run uses to keep one question at a time there, so a
 * recall is not timed while another question's embedding or reranking shares
 * the process; answering and judging, in other processes, still overlap.
 */
export async function evaluateInstance(
  lib,
  instance,
  { embedder, queryEmbedder = embedder, reranker = null, rerankDepth = null, topK = 20, aggregateTopK = null, freshness = 0, expand = false, recallPool, reading = "con", chainOfNote = false, answerer = null, judge = null, exclusive = (fn) => fn() } = {},
) {
  const started = Date.now();
  const { memories, rounds, memoriesRecalled, recall } = await exclusive(async () => {
    const memory = await ingestHistory(lib, instance, { embedder, queryEmbedder, reranker, rerankDepth });
    try {
      const recalled = await recallRounds(memory, instance, { freshness, expand, ...(recallPool ? { recallPool } : {}) });
      return { memories: memory.memories, ...recalled, recall: { ...recalled.recall, load1: Math.round(loadavg()[0] * 100) / 100 } };
    } finally {
      memory.store.close();
    }
  });
  const { corpus, correct } = corpusOf(instance);
  const skipped = retrievalSkipReason(instance);
  const cues = lib.analyzeQuery(instance.question, { now: parseSessionDate(instance.question_date) });
  const shown = rounds.slice(0, cues.aggregation && aggregateTopK ? aggregateTopK : topK);
  const readingUsed = chainOfNote && cues.aggregation ? "chain-of-note" : reading;
  const row = {
    question_id: instance.question_id,
    question_type: instance.question_type,
    abstention: isAbstention(instance.question_id),
    memories,
    memoriesRecalled,
    recall,
    cues: { aggregation: cues.aggregation, order: cues.order, windows: cues.windows.map((w) => w.phrase), parts: cues.parts.length },
    retrieval: skipped
      ? { skipped }
      : {
          skipped: null,
          metrics: retrievalMetrics(rounds.map((r) => r.id), correct, corpus.map((c) => c.id)),
          shown: shownEvidence(shown.map((r) => r.id), correct),
        },
    shownRounds: shown.map((r) => r.id),
    reading: readingUsed,
  };
  if (answerer) {
    const prompt = answerPrompt(instance, shown, readingUsed);
    const answer = await answerer.complete(prompt);
    Object.assign(row, { promptChars: prompt.length, hypothesis: answer.text, answerModels: answer.modelIds, answerUsage: answer.usage, answerNotionalCostUsd: answer.notionalCostUsd });
    if (judge) {
      const verdict = await judge.complete(judgePrompt(instance.question_type, instance.question, instance.answer, answer.text, row.abstention));
      Object.assign(row, { judgeResponse: verdict.text, label: judgeLabel(verdict.text), judgeModels: verdict.modelIds, judgeUsage: verdict.usage, judgeNotionalCostUsd: verdict.notionalCostUsd });
    }
  }
  row.ms = Date.now() - started;
  return row;
}

/** `fn`s passed to the function this returns run one at a time, in the order they came. */
export function oneAtATime() {
  let tail = Promise.resolve();
  return (fn) => {
    const run = tail.then(fn);
    tail = run.catch(() => {});
    return run;
  };
}

/**
 * Evaluate `instances`, `concurrency` at a time, calling `onRow` as each one
 * finishes (the CLI appends it to a progress file). A question that fails
 * after its retries becomes a row with `error` and the run goes on; a usage
 * limit stops the run once the questions in flight finish, and rethrows.
 * Memory building and recall go one question at a time (see
 * `evaluateInstance`); only answering and judging run `concurrency` wide.
 */
export async function runInstances(lib, instances, options, { concurrency = 4, onRow = () => {} } = {}) {
  const rows = [];
  let next = 0;
  let stop = null;
  const exclusive = oneAtATime();
  const worker = async () => {
    while (stop === null && next < instances.length) {
      const instance = instances[next++];
      let row;
      try {
        row = await evaluateInstance(lib, instance, { ...options, exclusive });
      } catch (e) {
        if (e instanceof UsageLimitError) {
          stop ??= e;
          return;
        }
        row = { question_id: instance.question_id, question_type: instance.question_type, abstention: isAbstention(instance.question_id), error: String(e?.message ?? e) };
      }
      rows.push(row);
      await onRow(row);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, instances.length)) }, worker));
  if (stop) throw Object.assign(stop, { rows });
  return rows;
}

/** Model ids seen, with how many calls each one answered. */
function modelCounts(rows, field) {
  const counts = {};
  for (const r of rows) for (const id of r[field] ?? []) counts[id] = (counts[id] ?? 0) + 1;
  return counts;
}

/** Sum of every numeric field of the CLI's `usage` objects. */
function sumUsage(rows, field) {
  const total = {};
  for (const r of rows) {
    for (const [k, v] of Object.entries(r[field] ?? {})) if (typeof v === "number") total[k] = (total[k] ?? 0) + v;
  }
  return total;
}

const sum = (rows, field) => rows.reduce((a, r) => a + (typeof r[field] === "number" ? r[field] : 0), 0);

/** Everything a results file reports about a set of rows. */
export function summarize(rows) {
  const ok = rows.filter((r) => !r.error);
  return {
    questions: rows.length,
    errors: rows.length - ok.length,
    qa: summarizeQa(ok),
    retrieval: summarizeRetrieval(ok),
    recall: summarizeRecallTime(ok),
    answered: ok.filter((r) => typeof r.hypothesis === "string").length,
    models: { answer: modelCounts(ok, "answerModels"), judge: modelCounts(ok, "judgeModels") },
    usage: { answer: sumUsage(ok, "answerUsage"), judge: sumUsage(ok, "judgeUsage") },
    notionalCostUsd: Math.round((sum(ok, "answerNotionalCostUsd") + sum(ok, "judgeNotionalCostUsd")) * 100) / 100,
    meanPromptChars: ok.length ? Math.round(sum(ok, "promptChars") / Math.max(1, ok.filter((r) => r.promptChars).length)) : null,
    meanSecondsPerQuestion: ok.length ? Math.round(sum(ok, "ms") / ok.length / 100) / 10 : null,
  };
}
