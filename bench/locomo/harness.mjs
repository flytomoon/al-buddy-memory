/**
 * LoCoMo end to end: a conversation's memory built once, every question of it
 * recalled against it, then each question read, answered and judged — against
 * the published key and, where the audit corrects it, against the corrected
 * key too.
 */
import { loadavg } from "node:os";

import { UsageLimitError } from "../longmemeval/answerers.mjs";
import { judgeLabel as longMemEvalLabel } from "../longmemeval/prompts.mjs";
import { ingestConversation, recallTurns } from "./memory.mjs";
import { readerInputTokens, retrievalFor } from "./metrics.mjs";
import { adversarialJudgePrompt, answerPrompt, judgeLabel, judgePrompt, keywordRule } from "./prompts.mjs";

/**
 * Build `conversation`'s memory and recall each of `questions` against it, one
 * at a time (so a recall is never timed while another runs). A question whose
 * recall throws gets `{ error }` and the rest go on; a memory that cannot be
 * built throws.
 */
export async function recallConversation(lib, conversation, questions, { embedder, expand = false, recallPool, store } = {}) {
  const memory = await ingestConversation(lib, conversation, { embedder, ...(store ? { store } : {}) });
  try {
    const recalled = [];
    for (const question of questions) {
      try {
        const r = await recallTurns(memory, conversation, question, { expand, ...(recallPool ? { recallPool } : {}) });
        recalled.push({ question, ...r, recall: { ...r.recall, load1: Math.round(loadavg()[0] * 100) / 100 } });
      } catch (e) {
        recalled.push({ question, error: `recall failed: ${e?.message ?? e}` });
      }
    }
    return { memories: memory.memories, recalled };
  } finally {
    // SQLite stores hold a handle; the in-memory one the tests use has nothing to close.
    memory.store.close?.();
  }
}

/** The fields every row carries, error or not. */
function baseRow(question, auditKey) {
  const fix = auditKey?.get(question.question_id) ?? null;
  return {
    question_id: question.question_id,
    sample_id: question.sample_id,
    category: question.category,
    adversarial: question.adversarial,
    question: question.question,
    answer: question.answer,
    correctedAnswer: fix ? fix.correctAnswer : null,
    auditErrorType: fix ? fix.errorType : null,
    ...(question.adversarial ? { adversarialAnswer: question.adversarialAnswer } : {}),
    evidence: question.evidence,
    ...(question.evidenceUnresolved.length ? { evidenceUnresolved: question.evidenceUnresolved } : {}),
  };
}

/**
 * One question's row, from its recall: retrieval numbers, then (with an
 * answerer) the reader's answer, then (with judges) the verdicts. A scored
 * question is judged by the pinned LoCoMo judge against the published
 * answer, and again against the audit's when the audit changes it
 * (`labelCorrected`; otherwise the same verdict). An adversarial one is judged
 * by `abstentionJudge` on whether it says the conversation does not hold the
 * answer, and by LoCoMo's keyword rule.
 */
export async function evaluateQuestion(conversation, recalled, { memories, topK = 40, reading = "c25", answerer = null, judge = null, abstentionJudge = null, auditKey = null } = {}) {
  const started = Date.now();
  const { question, turns } = recalled;
  const shown = turns.slice(0, topK);
  const row = {
    ...baseRow(question, auditKey),
    memories,
    memoriesRecalled: recalled.memoriesRecalled,
    recall: recalled.recall,
    retrieval: retrievalFor(turns.map((t) => t.diaId), shown.map((t) => t.diaId), question.evidence),
    shownTurns: shown.map((t) => t.diaId),
    reading,
  };
  if (answerer) {
    const prompt = answerPrompt(conversation, question, shown, reading);
    const answer = await answerer.complete(prompt);
    Object.assign(row, {
      promptChars: prompt.length,
      hypothesis: answer.text,
      readerInputTokens: readerInputTokens(answer.usage),
      answerModels: answer.modelIds,
      answerUsage: answer.usage,
      answerNotionalCostUsd: answer.notionalCostUsd,
    });
    if (question.adversarial) {
      row.keywordRule = keywordRule(answer.text);
      if (abstentionJudge) {
        const verdict = await abstentionJudge.complete(adversarialJudgePrompt(question, answer.text));
        Object.assign(row, { judgeResponse: verdict.text, label: longMemEvalLabel(verdict.text), judgeModels: verdict.modelIds, judgeUsage: verdict.usage, judgeNotionalCostUsd: verdict.notionalCostUsd });
      }
    } else if (judge) {
      const verdict = await judge.complete(judgePrompt(question.question, question.answer, answer.text));
      Object.assign(row, { judgeResponse: verdict.text, label: judgeLabel(verdict.text), judgeModels: verdict.modelIds, judgeUsage: verdict.usage, judgeNotionalCostUsd: verdict.notionalCostUsd });
      if (row.correctedAnswer !== null) {
        const fixed = await judge.complete(judgePrompt(question.question, row.correctedAnswer, answer.text));
        Object.assign(row, { judgeCorrectedResponse: fixed.text, labelCorrected: judgeLabel(fixed.text), judgeCorrectedModels: fixed.modelIds, judgeCorrectedUsage: fixed.usage, judgeCorrectedNotionalCostUsd: fixed.notionalCostUsd });
      } else row.labelCorrected = row.label;
    }
  }
  row.ms = Date.now() - started;
  return row;
}

/**
 * Every selected question of `conversations`, a conversation at a time:
 * build and recall, then answer and judge `concurrency` wide, calling `onRow`
 * as each question finishes (the CLI appends it to a progress file).
 * Questions in `done` are skipped. A question that fails becomes a row with
 * `error` (why, in its own words) and the run goes on; 3 failures in a row
 * stop it, and so does a usage limit (once the questions in flight finish).
 * A stopped run throws, carrying `attempted` and `succeeded`.
 */
export async function runLocomo(lib, conversations, options, { concurrency = 4, onRow = () => {}, done = new Set() } = {}) {
  const rows = [];
  let stop = null;
  let attempted = 0;
  let consecutiveFailures = 0;
  const record = async (row) => {
    attempted += 1;
    try {
      await onRow(row);
    } catch (e) {
      stop ??= new Error(`Could not record ${row.question_id}: ${e?.message ?? e}`);
      return;
    }
    rows.push(row);
    consecutiveFailures = row.error ? consecutiveFailures + 1 : 0;
    if (consecutiveFailures >= 3) stop ??= new Error(`Stopped after 3 consecutive question failures (the last: ${row.error})`);
  };
  for (const conversation of conversations) {
    if (stop) break;
    const todo = conversation.questions.filter((q) => !done.has(q.question_id));
    if (todo.length === 0) continue;
    let built;
    try {
      built = await recallConversation(lib, conversation, todo, options);
    } catch (e) {
      const why = `building the memory of ${conversation.sampleId} failed: ${e?.message ?? e}`;
      for (const q of todo) {
        if (stop) break;
        await record({ ...baseRow(q, options.auditKey), error: why });
      }
      continue;
    }
    let next = 0;
    const worker = async () => {
      while (stop === null && next < built.recalled.length) {
        const recalled = built.recalled[next++];
        let row;
        if (recalled.error) row = { ...baseRow(recalled.question, options.auditKey), error: recalled.error };
        else {
          try {
            row = await evaluateQuestion(conversation, recalled, { ...options, memories: built.memories });
          } catch (e) {
            if (e instanceof UsageLimitError) {
              stop ??= e;
              return;
            }
            row = { ...baseRow(recalled.question, options.auditKey), error: String(e?.message ?? e) };
          }
        }
        await record(row);
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, built.recalled.length)) }, worker));
  }
  if (stop) throw Object.assign(stop, { rows, attempted, succeeded: rows.filter((r) => !r.error).length });
  return rows;
}
