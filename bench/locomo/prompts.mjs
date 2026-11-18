/**
 * The prompts a LoCoMo number is made of: the reader's, the judge's, and how
 * the recalled turns are shown to the reader.
 *
 * LoCoMo's own code scores answers by token F1; every published memory-system
 * number since [C25] (Chhikara et al. 2025, arXiv 2504.19413) is instead an
 * LLM judge's "J" score, with an answer prompt and a judge prompt that the
 * independent audit (github.com/dial481/locomo-audit at
 * 9493fb4b4af4256ed17a18e8fd0b3cfdeec29539) keeps byte for byte in
 * `evaluation/config/prompts.yaml` (SHA-256 ba4f668e…ba498ee9, the evaluation
 * pipeline the leaders' tables come from). The strings below are copied from
 * that file verbatim:
 *
 *   - the judge: `llm_judge.system_prompt` and `llm_judge.user_prompt`;
 *   - the reader: the first of `online_api.default`'s answer prompts (lines
 *     37-72, the one [C25] ships; `--reading c25`, the default), or
 *     `answer_prompt_memos` (lines 74-104; `--reading memos`).
 *
 * Not from that file, and said so in every result: the context block (each
 * system there fills `{context}` with its own template; ours is below, and
 * with `--support-check` it can end with that check's note), and
 * the grading of the 446 adversarial questions, which no published pipeline
 * scores (the audit's "Category 5 evaluation gap"). Those are graded twice:
 * by LongMemEval's official abstention judge prompt (the same one
 * bench/longmemeval uses), and by LoCoMo's own rule from its
 * task_eval/evaluation.py (the answer says "not mentioned" or "no
 * information available").
 *
 * Change nothing here without saying so in the result file.
 */
import { judgePrompt as longMemEvalJudgePrompt } from "../longmemeval/prompts.mjs";

export const AUDIT_COMMIT = "9493fb4b4af4256ed17a18e8fd0b3cfdeec29539";
export const PROMPTS_SOURCE = `https://github.com/dial481/locomo-audit/blob/${AUDIT_COMMIT}/evaluation/config/prompts.yaml`;
export const PROMPTS_SHA256 = "ba4f668e72c3fba74a58b8ee56064568fb9c6aae1441e4f0f7a8f5edba498ee9";
export const LOCOMO_COMMIT = "3eb6f2c585f5e1699204e3c3bdf7adc5c28cb376";
export const KEYWORD_RULE_SOURCE = `https://github.com/snap-research/locomo/blob/${LOCOMO_COMMIT}/task_eval/evaluation.py#L216-L221`;

export const JUDGE_SYSTEM = "You are an expert grader that determines if answers to questions match a gold standard answer\n";

const JUDGE_USER =
  "Your task is to label an answer to a question as 'CORRECT' or 'WRONG'. You will be given the following data:\n    (1) a question (posed by one user to another user),\n    (2) a 'gold' (ground truth) answer,\n    (3) a generated answer\nwhich you will score as CORRECT/WRONG.\n\nThe point of the question is to ask about something one user should know about the other user based on their prior conversations.\nThe gold answer will usually be a concise and short answer that includes the referenced topic, for example:\nQuestion: Do you remember what I got the last time I went to Hawaii?\nGold answer: A shell necklace\nThe generated answer might be much longer, but you should be generous with your grading - as long as it touches on the same topic as the gold answer, it should be counted as CORRECT.\n\nFor time related questions, the gold answer will be a specific date, month, year, etc. The generated answer might be much longer or use relative time references (like \"last Tuesday\" or \"next month\"), but you should be generous with your grading - as long as it refers to the same date or time period as the gold answer, it should be counted as CORRECT. Even if the format differs (e.g., \"May 7th\" vs \"7 May\"), consider it CORRECT if it's the same date.\n\nNow it's time for the real question:\nQuestion: {question}\nGold answer: {golden_answer}\nGenerated answer: {generated_answer}\n\nFirst, provide a short (one sentence) explanation of your reasoning, then finish with CORRECT or WRONG.\nDo NOT include both CORRECT and WRONG in your response, or it will break the evaluation script.\n\nJust return the label CORRECT or WRONG in a json format with the key as \"label\".\n";

export const READING_TEMPLATES = {
  c25:
    "You are an intelligent memory assistant tasked with retrieving accurate information from conversation memories.\n\n# CONTEXT:\nYou have access to memories from two speakers in a conversation. These memories contain\ntimestamped information that may be relevant to answering the question.\n\n# INSTRUCTIONS:\n1. Carefully analyze all provided memories from both speakers\n2. Pay special attention to the timestamps to determine the answer\n3. If the question asks about a specific event or fact, look for direct evidence in the memories\n4. If the memories contain contradictory information, prioritize the most recent memory\n5. If there is a question about time references (like \"last year\", \"two months ago\", etc.),\n   calculate the actual date based on the memory timestamp. For example, if a memory from\n   4 May 2022 mentions \"went to India last year,\" then the trip occurred in 2021.\n6. Always convert relative time references to specific dates, months, or years. For example,\n   convert \"last year\" to \"2022\" or \"two months ago\" to \"March 2023\" based on the memory\n   timestamp. Ignore the reference while answering the question.\n7. Focus only on the content of the memories from both speakers. Do not confuse character\n   names mentioned in memories with the actual users who created those memories.\n8. The answer should be less than 5-6 words.\n\n# APPROACH (Think step by step):\n1. First, examine all memories that contain information related to the question\n2. Examine the timestamps and content of these memories carefully\n3. Look for explicit mentions of dates, times, locations, or events that answer the question\n4. If the answer requires calculation (e.g., converting relative time references), show your work\n5. Formulate a precise, concise answer based solely on the evidence in the memories\n6. Double-check that your answer directly addresses the question asked\n7. Ensure your final answer is specific and avoids vague time references\n\n{context}\n\nQuestion: {question}\n\nAnswer:\n",
  memos:
    "You are a knowledgeable and helpful AI assistant.\n\n# CONTEXT:\nYou have access to memories from two speakers in a conversation. These memories contain\ntimestamped information that may be relevant to answering the question.\n\n# INSTRUCTIONS:\n1. Carefully analyze all provided memories. Synthesize information across different entries if needed to form a complete answer.\n2. Pay close attention to the timestamps to determine the answer. If memories contain contradictory information, the **most recent memory** is the source of truth.\n3. If the question asks about a specific event or fact, look for direct evidence in the memories.\n4. Your answer must be grounded in the memories. However, you may use general world knowledge to interpret or complete information found within a memory (e.g., identifying a landmark mentioned by description).\n5. If the question involves time references (like \"last year\", \"two months ago\", etc.), you **must** calculate the actual date based on the memory's timestamp. For example, if a memory from 4 May 2022 mentions \"went to India last year,\" then the trip occurred in 2021.\n6. Always convert relative time references to specific dates, months, or years in your final answer.\n7. Do not confuse character names mentioned in memories with the actual users who created them.\n8. The answer must be brief (under 5-6 words) and direct, with no extra description.\n\n# APPROACH (Think step by step):\n1. First, examine all memories that contain information related to the question.\n2. Synthesize findings from multiple memories if a single entry is insufficient.\n3. Examine timestamps and content carefully, looking for explicit dates, times, locations, or events.\n4. If the answer requires calculation (e.g., converting relative time references), perform the calculation.\n5. Formulate a precise, concise answer based on the evidence from the memories (and allowed world knowledge).\n6. Double-check that your answer directly addresses the question asked and adheres to all instructions.\n7. Ensure your final answer is specific and avoids vague time references.\n\n{context}\n\nQuestion: {question}\n\nAnswer:\n",
};

/** Python's `str.format` with named fields, for the fields these templates use; any other brace is left alone. */
export function fill(template, values) {
  return template.replace(/\{([a-z_]+)\}/g, (whole, name) => (name in values ? String(values[name]) : whole));
}

/**
 * The text one turn is stored and shown as: who said it, what they said, and
 * the caption of any photo they shared (LoCoMo's own evaluation_stats.py
 * writes it as "[shares <caption>]"; the photos themselves are not used).
 */
export function turnText(turn) {
  return `${turn.speaker}: ${turn.text}${turn.caption ? ` [shares ${turn.caption}]` : ""}`;
}

/**
 * NOT from the pinned prompts file: the `{context}` block, ours. The turns the
 * reader is shown, in conversation order (session, then turn), each line led
 * by the date of the session it was said in.
 */
export const CONTEXT_TEMPLATE_DESCRIPTION =
  "\"Memories from the conversation between <speaker a> and <speaker b>, oldest first; each line is one message, led by the date of the session it was said in:\" then one line per shown turn, \"[<session date as the dataset writes it>] <speaker>: <text>[ [shares <photo caption>]]\", sorted by session and turn";

/** `note`, when given (the support check's, bench/locomo/support.mjs), is a paragraph after the memories; they are shown as they are either way. */
export function formatContext(speakers, turns, note = null) {
  const sorted = [...turns].sort((a, b) => a.session - b.session || a.position - b.position);
  return [
    `Memories from the conversation between ${speakers[0]} and ${speakers[1]}, oldest first; each line is one message, led by the date of the session it was said in:`,
    "",
    ...sorted.map((t) => `[${t.dateText}] ${turnText(t)}`),
    ...(note ? ["", note] : []),
  ].join("\n");
}

/** The reader's prompt for one question, given the turns it is shown (and the support check's note, when it fired). */
export function answerPrompt(conversation, question, turns, reading = "c25", { note = null } = {}) {
  const template = READING_TEMPLATES[reading];
  if (!template) throw new Error(`Unknown reading "${reading}" (use ${Object.keys(READING_TEMPLATES).join(" or ")})`);
  return fill(template, { context: formatContext(conversation.speakers, turns, note), question: question.question });
}

/** The judge's prompt for a scored (non-adversarial) question, against the key's answer or the audit's corrected one. */
export function judgePrompt(question, goldAnswer, response) {
  return fill(JUDGE_USER, { question, golden_answer: goldAnswer, generated_answer: response });
}

/**
 * The judge's label. The prompt asks for `{"label": "CORRECT"}` or WRONG, in
 * JSON, after a sentence of reasoning: the last such object decides. With no
 * JSON, a response holding exactly one of the two words is read as that word.
 * Anything else throws, so the question is recorded as an error and retried
 * on --resume, never counted as wrong.
 */
export function judgeLabel(response) {
  const objects = [...String(response).matchAll(/\{[^{}]*?"label"\s*:\s*"([A-Za-z]+)"[^{}]*\}/g)];
  if (objects.length) {
    const label = objects.at(-1)[1].toUpperCase();
    if (label === "CORRECT") return true;
    if (label === "WRONG") return false;
  }
  const correct = /\bCORRECT\b/.test(response);
  const wrong = /\bWRONG\b/.test(response);
  if (correct !== wrong) return correct;
  throw new Error(`The judge gave no single CORRECT or WRONG label: ${JSON.stringify(String(response).slice(0, 200))}`);
}

/**
 * NOT an official LoCoMo grader (none exists): an adversarial question is
 * graded by LongMemEval's official abstention judge prompt, verbatim, with
 * this as its "Explanation". The judge's system prompt and yes/no rule are
 * LongMemEval's too.
 */
export function adversarialExplanation(question) {
  return `The conversation does not say this. "${question.adversarialAnswer}" is the plausible answer the question invites, and nothing in the conversation supports it for the person and thing asked about.`;
}

export function adversarialJudgePrompt(question, response) {
  return longMemEvalJudgePrompt("multi-session", question.question, adversarialExplanation(question), response, true);
}

/** LoCoMo's own category-5 rule (task_eval/evaluation.py): the answer says it was not mentioned. */
export function keywordRule(response) {
  const text = String(response).toLowerCase();
  return text.includes("no information available") || text.includes("not mentioned");
}
