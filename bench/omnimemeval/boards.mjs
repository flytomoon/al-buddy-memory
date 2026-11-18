/**
 * The five OmniMemEval boards: how its harness runs each one, where it
 * writes the result, which number is the headline, and what a full run is
 * expected to cost under the shared reader and judge.
 */
import { costUsd } from "./meter.mjs";
import { ANSWER_MODEL, EVAL_MODEL, LIB } from "./pin.mjs";

/**
 * The run order: the boards every leader quotes first, then BEAM (the one
 * newcomers lead with), HaluMem, and PersonaMem v2 last — the largest
 * (5,000 questions, about half the expected spend), so if the cap is
 * reached it is reached there.
 */
export const BOARD_ORDER = ["locomo", "longmemeval", "beam", "halumem", "personamem_v2"];

/**
 * `script`: the harness's runner. `results`: its results directory.
 * `grades`: the metric stage's output, inside it. `score`: the headline in
 * that file. `streaming`: run in the harness's add-search-delete mode, one
 * conversation's store at a time (LoCoMo has no such mode; its ten stores
 * are built first). `questions`: the full board's count, from OmniMemEval's
 * own docs at the pin.
 */
export function boardSpec(board, { beamScale = "100k", halumemVariant = "medium" } = {}) {
  const specs = {
    locomo: { script: "scripts/run_locomo_eval.sh", results: "results/locomo", grades: `${LIB}_locomo_grades.json`, score: ["metrics", "llm_judge_score"], streaming: false, extra: [], questions: 1540, prepare: null, label: "LoCoMo (categories 1-4)" },
    longmemeval: { script: "scripts/run_lme_eval.sh", results: "results/lme", grades: `${LIB}_lme_grades.json`, score: ["metrics", "llm_judge_score"], streaming: true, extra: [], questions: 500, prepare: ["data/longmemeval/prepare_longmemeval.py", "--variant", "s"], label: "LongMemEval-S" },
    beam: { script: "scripts/run_beam_eval.sh", results: "results/beam", grades: `${LIB}_beam_grades.json`, score: ["overall", "nugget_score_mean"], streaming: true, extra: ["--scale", beamScale], questions: { "100k": 400, "10m": 200 }[beamScale] ?? null, prepare: ["data/beam/prepare_beam.py", "--scale", beamScale], label: `BEAM ${beamScale.toUpperCase()}` },
    personamem_v2: { script: "scripts/run_pmv2_eval.sh", results: "results/pmv2", grades: `${LIB}_pm_grades.json`, score: ["metrics", "accuracy"], streaming: true, extra: [], questions: 5000, prepare: ["data/personamem_v2/prepare_personamem.py"], label: "PersonaMem v2" },
    halumem: { script: "scripts/run_halumem_eval.sh", results: "results/halumem", grades: `${LIB}_hm_grades.json`, score: ["metrics", "llm_judge_score"], streaming: true, extra: ["--variant", halumemVariant], questions: halumemVariant === "medium" ? 3467 : null, prepare: ["data/halumem/prepare_halumem.py", "--variant", halumemVariant], label: `HaluMem ${halumemVariant}` },
  };
  const spec = specs[board];
  if (!spec) throw new Error(`unknown board ${board}: one of ${BOARD_ORDER.join(", ")}`);
  return { board, ...spec };
}

/**
 * Per question, what a full run sends the reader and the judge. Reader
 * prompt tokens are the board's answer prompt plus our 20 recalled messages
 * plus the question. LoCoMo and LongMemEval are measured: the 2026-11-18 dry
 * run through OmniMemEval's own pipeline (233 LoCoMo questions: 1,402 mean;
 * 2 LongMemEval questions: 4,507 mean; characters/4, not the model's
 * tokenizer). The other three could not be downloaded in that job, so their
 * reader prompts are estimates (the board's prompt template, measured, plus
 * 20 messages of an assumed length), marked as such. Judge prompts are the
 * measured templates (430 tokens for the shared judge, 248 for BEAM's rubric
 * item) plus question, key and answer. Judge calls per question: one for the
 * LLM-as-judge boards, about four rubric items for BEAM (an estimate; the
 * harness judges each rubric item on its own), none for PersonaMem v2
 * (option matching). Every number here is a planning figure; the meter's
 * ledger is what a run actually cost.
 */
export const COST_INPUTS = {
  locomo: { readerPrompt: 1_400, readerOutput: 80, judgeCalls: 1, judgePrompt: 550, judgeOutput: 60, source: "reader prompt measured (233 questions)" },
  longmemeval: { readerPrompt: 4_500, readerOutput: 100, judgeCalls: 1, judgePrompt: 550, judgeOutput: 60, source: "reader prompt measured (2 questions only)" },
  beam: { readerPrompt: 5_000, readerOutput: 300, judgeCalls: 4, judgePrompt: 600, judgeOutput: 80, source: "estimate: LongMemEval-sized messages, long answers, ~4 rubric items" },
  halumem: { readerPrompt: 3_000, readerOutput: 80, judgeCalls: 1, judgePrompt: 500, judgeOutput: 60, source: "estimate: shorter dialogue turns" },
  personamem_v2: { readerPrompt: 4_500, readerOutput: 30, judgeCalls: 0, judgePrompt: 0, judgeOutput: 0, source: "estimate: LongMemEval-sized persona chats; option matching, no judge" },
};

/** How much more than its estimate a board may cost before the runner will not start it on what is left of the cap. */
export const ESTIMATE_MARGIN = 1.25;

/** The expected USD of a full board at list prices, and the parts it is made of. */
export function expectedCost(board, { questions } = {}) {
  const c = COST_INPUTS[board];
  const q = questions ?? boardSpec(board).questions;
  if (!c || !q) return null;
  const reader = costUsd(ANSWER_MODEL, { prompt_tokens: c.readerPrompt * q, completion_tokens: c.readerOutput * q });
  const judge = costUsd(EVAL_MODEL, { prompt_tokens: c.judgePrompt * c.judgeCalls * q, completion_tokens: c.judgeOutput * c.judgeCalls * q });
  return { board, questions: q, readerCalls: q, judgeCalls: c.judgeCalls * q, readerUsd: reader, judgeUsd: judge, usd: reader + judge, source: c.source };
}

/** `obj` at `path`, or undefined. */
export function at(obj, path) {
  return path.reduce((o, k) => (o && typeof o === "object" ? o[k] : undefined), obj);
}
