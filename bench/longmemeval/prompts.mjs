/**
 * The official LongMemEval prompts, verbatim, and the history block the
 * official reader is shown.
 *
 * Copied from github.com/xiaowu0162/LongMemEval at commit
 * 9e0b455f4ef0e2ab8f2e582289761153549043fc:
 *   - answer templates: src/generation/run_generation.py, `prepare_prompt`
 *     (no key expansion; "con" is the `--cot true` template, the reading method
 *     the README recommends; "direct" is `--cot false`)
 *   - judge templates and the yes/no rule: src/evaluation/evaluate_qa.py,
 *     `get_anscheck_prompt`
 * Change nothing here without saying so in the result file: these strings are
 * what makes a number a LongMemEval number.
 */

export const LONGMEMEVAL_COMMIT = "9e0b455f4ef0e2ab8f2e582289761153549043fc";
export const SCORING_SOURCE = `https://github.com/xiaowu0162/LongMemEval/blob/${LONGMEMEVAL_COMMIT}/src/evaluation/evaluate_qa.py`;
export const READER_SOURCE = `https://github.com/xiaowu0162/LongMemEval/blob/${LONGMEMEVAL_COMMIT}/src/generation/run_generation.py`;

export const ANSWER_TEMPLATES = {
  con: "I will give you several history chats between you and a user. Please answer the question based on the relevant chat history. Answer the question step by step: first extract all the relevant information, and then reason over the information to get the answer.\n\n\nHistory Chats:\n\n{}\n\nCurrent Date: {}\nQuestion: {}\nAnswer (step by step):",
  direct: "I will give you several history chats between you and a user. Please answer the question based on the relevant chat history.\n\n\nHistory Chats:\n\n{}\n\nCurrent Date: {}\nQuestion: {}\nAnswer:",
};

/**
 * NOT an official template: the chain-of-note reader (`--chain-of-note`), for
 * questions that count, total, compare or order across sessions. It asks for a
 * note per relevant session, dated, before any arithmetic — a question lost to
 * a missed or double-counted mention is lost there — and the answer after, in
 * the same single call. It keeps the official frame (the same opening, the
 * same history block, "Current Date", "Question") so only the instructions
 * differ, and a result that used it says so.
 */
export const CHAIN_OF_NOTE_TEMPLATE =
  "I will give you several history chats between you and a user. Please answer the question based on the relevant chat history. The answer may need information from several of the chats: to count, add up, compare or order what they say.\n\n" +
  "Work in two steps.\n" +
  "Step 1, notes. Go through the history chats in order. For every session that mentions anything bearing on the question, write one line: the session date, then what that session says that matters, with its numbers, names and dates exactly as given. Note a mention even when you are unsure it counts, and note each session separately even when they repeat each other. Skip sessions with nothing relevant.\n" +
  "Step 2, answer. Using your notes, work out the answer. Count a thing once even when several sessions mention it. When the question names a period, keep only what happened in it, judged by when each thing happened: a date the session gives, or else the session date, against the current date. When a later session updates or corrects an earlier one, use the later one. If the chats hold nothing that answers the question, say so rather than guess. End with the final answer and the items or numbers it is built from.\n\n\n" +
  "History Chats:\n\n{}\n\nCurrent Date: {}\nQuestion: {}\nAnswer (notes first, then the answer):";

/** Every reading method: the two official templates, and the one that is not. */
export const READING_TEMPLATES = { ...ANSWER_TEMPLATES, "chain-of-note": CHAIN_OF_NOTE_TEMPLATE };

const JUDGE_DEFAULT =
  "I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no. \n\nQuestion: {}\n\nCorrect Answer: {}\n\nModel Response: {}\n\nIs the model response correct? Answer yes or no only.";
const JUDGE_TEMPORAL =
  "I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no. In addition, do not penalize off-by-one errors for the number of days. If the question asks for the number of days/weeks/months, etc., and the model makes off-by-one errors (e.g., predicting 19 days when the answer is 18), the model's response is still correct. \n\nQuestion: {}\n\nCorrect Answer: {}\n\nModel Response: {}\n\nIs the model response correct? Answer yes or no only.";
const JUDGE_KNOWLEDGE_UPDATE =
  "I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response contains some previous information along with an updated answer, the response should be considered as correct as long as the updated answer is the required answer.\n\nQuestion: {}\n\nCorrect Answer: {}\n\nModel Response: {}\n\nIs the model response correct? Answer yes or no only.";
const JUDGE_PREFERENCE =
  "I will give you a question, a rubric for desired personalized response, and a response from a model. Please answer yes if the response satisfies the desired response. Otherwise, answer no. The model does not need to reflect all the points in the rubric. The response is correct as long as it recalls and utilizes the user's personal information correctly.\n\nQuestion: {}\n\nRubric: {}\n\nModel Response: {}\n\nIs the model response correct? Answer yes or no only.";
const JUDGE_ABSTENTION =
  "I will give you an unanswerable question, an explanation, and a response from a model. Please answer yes if the model correctly identifies the question as unanswerable. The model could say that the information is incomplete, or some other information is given but the asked information is not.\n\nQuestion: {}\n\nExplanation: {}\n\nModel Response: {}\n\nDoes the model correctly identify the question as unanswerable? Answer yes or no only.";

/** Python's `str.format` for positional `{}` only — what the official templates use. */
export function format(template, ...args) {
  let i = 0;
  return template.replace(/\{\}/g, () => pyStr(args[i++]));
}

/** `'{}'.format(x)` for the values the dataset holds: strings, and the odd integer answer. */
function pyStr(x) {
  return typeof x === "string" ? x : String(x);
}

/**
 * Python's `json.dumps(x)` with its defaults (", " and ": " separators,
 * `ensure_ascii=True`), so the history block is byte-for-byte what the
 * official reader builds.
 */
export function pythonJsonDumps(x) {
  if (Array.isArray(x)) return `[${x.map(pythonJsonDumps).join(", ")}]`;
  if (x !== null && typeof x === "object") return `{${Object.entries(x).map(([k, v]) => `${asciiString(k)}: ${pythonJsonDumps(v)}`).join(", ")}}`;
  if (typeof x === "string") return asciiString(x);
  return JSON.stringify(x);
}

const asciiString = (s) => JSON.stringify(s).replace(/[\u0080-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);

/**
 * The history block for retrieved rounds (`flat-turn`, `json` history format):
 * sorted by session date — Python's stable sort on the date string — and each
 * round printed as its own numbered session.
 */
export function formatHistory(rounds) {
  const sorted = [...rounds].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return sorted
    // '\n### Session {}:\nSession Date: {}\nSession Content:\n{}\n' with the content '\n' + json.dumps(round)
    .map((r, i) => `\n### Session ${i + 1}:\nSession Date: ${r.date}\nSession Content:\n\n${pythonJsonDumps(r.turns)}\n`)
    .join("");
}

/** The reader's prompt for one question, given the rounds it is shown. */
export function answerPrompt(instance, rounds, reading = "con") {
  const template = READING_TEMPLATES[reading];
  if (!template) throw new Error(`Unknown reading method "${reading}" (use ${Object.keys(READING_TEMPLATES).join(", ")})`);
  return format(template, formatHistory(rounds), instance.question_date, instance.question);
}

/** The judge's prompt: the template for the question's type, or the abstention one. */
export function judgePrompt(questionType, question, answer, response, abstention) {
  if (abstention) return format(JUDGE_ABSTENTION, question, answer, response);
  switch (questionType) {
    case "single-session-user":
    case "single-session-assistant":
    case "multi-session":
      return format(JUDGE_DEFAULT, question, answer, response);
    case "temporal-reasoning":
      return format(JUDGE_TEMPORAL, question, answer, response);
    case "knowledge-update":
      return format(JUDGE_KNOWLEDGE_UPDATE, question, answer, response);
    case "single-session-preference":
      return format(JUDGE_PREFERENCE, question, answer, response);
    default:
      throw new Error(`No official judge prompt for question type "${questionType}"`);
  }
}

/** The official rule, exactly: `'yes' in eval_response.strip().lower()`. */
export function judgeLabel(response) {
  return response.trim().toLowerCase().includes("yes");
}
