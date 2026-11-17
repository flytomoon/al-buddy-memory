/**
 * LoCoMo conversations and questions: loading and checking them, the
 * corrected answer key from the independent audit, and the evidence turns.
 *
 * Field names are the dataset's own (data/locomo10.json of
 * github.com/snap-research/locomo). Each of the ten samples is one long
 * conversation between two people (`conversation.speaker_a`, `speaker_b`):
 * `session_<n>` lists of turns `{ speaker, dia_id, text, blip_caption? }`
 * and `session_<n>_date_time` like "1:56 pm on 8 May, 2023". `qa` lists the
 * questions: `{ question, answer, evidence: [dia_id…], category }`, where the
 * 446 of category 5 (adversarial) carry `adversarial_answer` instead of an
 * answer: the trap, a plausible answer the conversation does not support.
 *
 * Category numbers are reported as they are, with their sizes; vendors label
 * them differently (the same 282 questions are "multi-hop" in one table and
 * "single-hop" in another), so a result is compared by size, not by name.
 */
import { readFileSync } from "node:fs";

/** The dataset's categories, by size: 841 / 282 / 321 / 96 questions are scored; the 446 adversarial ones are reported beside them. */
export const CATEGORY_SIZES = { 1: 282, 2: 321, 3: 96, 4: 841, 5: 446 };
export const SCORED_CATEGORIES = [4, 1, 2, 3];
export const ADVERSARIAL = 5;

/** The audit's error types that change the answer (99 of them); WRONG_CITATION ones only move the evidence. */
export const CITATION_ONLY = "WRONG_CITATION";

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

/**
 * "1:56 pm on 8 May, 2023" → "2023-05-08T13:56:00.000Z". The dataset gives no
 * time zone; UTC is used for every date, as for LongMemEval.
 */
export function parseLocomoDate(text) {
  const m = /^(\d{1,2}):(\d{2}) ?(am|pm) on (\d{1,2}) ([A-Za-z]+),? (\d{4})$/i.exec(String(text).trim());
  if (!m) throw new Error(`Unrecognised LoCoMo date: ${JSON.stringify(text)}`);
  const [, h, mi, ampm, d, monthName, y] = m;
  const month = MONTHS.indexOf(monthName.toLowerCase());
  if (month < 0) throw new Error(`Unrecognised month in LoCoMo date: ${JSON.stringify(text)}`);
  let hour = Number(h);
  if (hour < 1 || hour > 12 || Number(mi) > 59) throw new Error(`Invalid LoCoMo time: ${JSON.stringify(text)}`);
  if (ampm.toLowerCase() === "pm" && hour !== 12) hour += 12;
  if (ampm.toLowerCase() === "am" && hour === 12) hour = 0;
  const date = new Date(Date.UTC(Number(y), month, Number(d), hour, Number(mi)));
  if (date.getUTCDate() !== Number(d) || date.getUTCMonth() !== month) throw new Error(`Invalid LoCoMo date: ${JSON.stringify(text)}`);
  return date.toISOString();
}

/**
 * One sample as the harness uses it: its sessions in order (only those with
 * turns; some samples list dates for sessions that hold none), every turn
 * with its session's date, and its questions. Throws naming the sample and
 * field when the shape is wrong.
 */
export function readConversation(sample, index) {
  const where = `sample ${index}${typeof sample?.sample_id === "string" ? ` (${sample.sample_id})` : ""}`;
  const conv = sample?.conversation;
  if (typeof sample?.sample_id !== "string") throw new Error(`${where}: sample_id must be a string`);
  if (!conv || typeof conv.speaker_a !== "string" || typeof conv.speaker_b !== "string") throw new Error(`${where}: conversation needs speaker_a and speaker_b`);
  if (!Array.isArray(sample.qa)) throw new Error(`${where}: qa must be an array`);
  const sessions = Object.keys(conv)
    .map((k) => /^session_(\d+)$/.exec(k))
    .filter(Boolean)
    .map((m) => Number(m[1]))
    .sort((a, b) => a - b)
    .filter((n) => Array.isArray(conv[`session_${n}`]) && conv[`session_${n}`].length > 0)
    .map((n) => {
      const dateText = conv[`session_${n}_date_time`];
      if (typeof dateText !== "string") throw new Error(`${where}: session_${n} has no session_${n}_date_time`);
      const turns = conv[`session_${n}`].map((t, i) => {
        if (typeof t?.speaker !== "string" || typeof t?.dia_id !== "string" || typeof t?.text !== "string") throw new Error(`${where}: session_${n} turn ${i} needs a string speaker, dia_id and text`);
        return { diaId: t.dia_id, speaker: t.speaker, text: t.text, caption: typeof t.blip_caption === "string" && t.blip_caption.trim() !== "" ? t.blip_caption : null };
      });
      return { session: n, dateText, date: parseLocomoDate(dateText), turns };
    });
  if (sessions.length === 0) throw new Error(`${where}: no session holds any turns`);
  const diaIds = new Set();
  for (const s of sessions) for (const t of s.turns) {
    if (diaIds.has(t.diaId)) throw new Error(`${where}: dia_id ${t.diaId} appears twice`);
    diaIds.add(t.diaId);
  }
  const questions = sample.qa.map((q, i) => {
    if (typeof q?.question !== "string") throw new Error(`${where}: qa ${i} needs a string question`);
    if (!Number.isInteger(q.category) || !(q.category in CATEGORY_SIZES)) throw new Error(`${where}: qa ${i} has category ${JSON.stringify(q.category)}`);
    const adversarial = q.category === ADVERSARIAL;
    if (!adversarial && (q.answer === undefined || q.answer === null)) throw new Error(`${where}: qa ${i} (category ${q.category}) has no answer`);
    if (adversarial && typeof q.adversarial_answer !== "string") throw new Error(`${where}: qa ${i} (adversarial) has no adversarial_answer`);
    const evidence = resolveEvidence(Array.isArray(q.evidence) ? q.evidence : [], diaIds);
    return {
      // The audit's id: the sample's place in the file and the question's place in its qa list, both from 0.
      question_id: `locomo_${index}_qa${i}`,
      sample_id: sample.sample_id,
      category: q.category,
      adversarial,
      question: q.question,
      answer: adversarial ? null : String(q.answer),
      adversarialAnswer: adversarial ? q.adversarial_answer : null,
      evidence: evidence.ids,
      evidenceUnresolved: evidence.unresolved,
    };
  });
  return { index, sampleId: sample.sample_id, speakers: [conv.speaker_a, conv.speaker_b], sessions, questions, now: sessions.at(-1).date };
}

/**
 * The dataset's evidence strings as dia_ids of this conversation. A few are
 * malformed in the published file ("D8:6; D9:17", "D:11:26", "D30:05"):
 * every `D<session>:<turn>` in a string is read, with leading zeros dropped.
 * What still names no turn of the conversation is returned as unresolved,
 * never silently dropped.
 */
export function resolveEvidence(evidence, diaIds) {
  const ids = [];
  const unresolved = [];
  for (const raw of evidence) {
    const found = [...String(raw).matchAll(/D:?(\d+):(\d+)/g)].map((m) => `D${Number(m[1])}:${Number(m[2])}`);
    if (found.length === 0) unresolved.push(String(raw));
    for (const id of found) {
      if (diaIds.has(id)) {
        if (!ids.includes(id)) ids.push(id);
      } else unresolved.push(String(raw) === id ? id : `${raw} (${id})`);
    }
  }
  return { ids, unresolved };
}

export function loadConversations(path) {
  const data = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(data)) throw new Error(`${path}: expected a JSON array of LoCoMo samples`);
  return data.map(readConversation);
}

/**
 * The audit's corrected key: question_id → `{ correctAnswer, errorType }`
 * for every entry whose error type changes the answer (everything but
 * WRONG_CITATION). Each entry is checked against the dataset — same
 * question, same golden answer, same category — so a key that has drifted
 * from the data is refused rather than applied to the wrong questions.
 */
export function loadAuditKey(path, conversations) {
  const entries = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(entries)) throw new Error(`${path}: expected a JSON array of audit entries`);
  const byId = new Map(conversations.flatMap((c) => c.questions.map((q) => [q.question_id, q])));
  const key = new Map();
  for (const [i, e] of entries.entries()) {
    const q = byId.get(e?.question_id);
    if (!q) throw new Error(`${path}: entry ${i} names ${JSON.stringify(e?.question_id)}, which is not a question in the data`);
    if (e.question !== q.question) throw new Error(`${path}: entry ${i} (${e.question_id}) is for ${JSON.stringify(e.question)}, the data has ${JSON.stringify(q.question)}`);
    if (String(e.golden_answer) !== q.answer || e.category !== q.category) throw new Error(`${path}: entry ${i} (${e.question_id}) has golden answer ${JSON.stringify(e.golden_answer)} / category ${e.category}; the data has ${JSON.stringify(q.answer)} / ${q.category}`);
    if (e.error_type === CITATION_ONLY) continue;
    if (typeof e.correct_answer !== "string" || e.correct_answer.trim() === "") throw new Error(`${path}: entry ${i} (${e.question_id}, ${e.error_type}) has no correct_answer`);
    if (key.has(e.question_id)) throw new Error(`${path}: ${e.question_id} is corrected twice`);
    key.set(e.question_id, { correctAnswer: e.correct_answer, errorType: e.error_type });
  }
  return key;
}

/**
 * Which questions a run covers: the first `conversations` samples (all ten by
 * default), and within them the `categories` asked for (all five by default).
 */
export function selectQuestions(conversations, { conversations: n, categories } = {}) {
  const unknown = (categories ?? []).filter((c) => !(c in CATEGORY_SIZES));
  if (unknown.length) throw new Error(`Unknown category ${unknown.join(", ")} (have: ${Object.keys(CATEGORY_SIZES).join(", ")})`);
  return conversations.slice(0, n ?? conversations.length).map((c) => ({ ...c, questions: c.questions.filter((q) => !categories?.length || categories.includes(q.category)) }));
}
