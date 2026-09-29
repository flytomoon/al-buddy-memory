/**
 * LongMemEval instances: loading and checking them, choosing which to run, and
 * the corpus ids the official retrieval metrics are computed over.
 *
 * Field names are the dataset's own (README of github.com/xiaowu0162/LongMemEval,
 * "Dataset Format"). Each instance is one question with its own history: a list
 * of timestamped sessions, each a list of `{ role, content }` turns, where turns
 * holding the evidence carry `has_answer: true`.
 */
import { readFileSync } from "node:fs";

/** The six question types, in the order the official metrics script prints them. */
export const QUESTION_TYPES = [
  "single-session-user",
  "single-session-preference",
  "single-session-assistant",
  "multi-session",
  "temporal-reasoning",
  "knowledge-update",
];

/** An abstention question is one whose id ends in `_abs` (the official scripts test `'_abs' in id`). */
export const isAbstention = (questionId) => questionId.includes("_abs");

export function loadInstances(path) {
  const data = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(data)) throw new Error(`${path}: expected a JSON array of LongMemEval instances`);
  data.forEach(checkInstance);
  return data;
}

/** Throws with the instance and field named when an instance is not LongMemEval-shaped. */
export function checkInstance(x, index) {
  const where = `instance ${index}${typeof x?.question_id === "string" ? ` (${x.question_id})` : ""}`;
  for (const field of ["question_id", "question_type", "question", "question_date"]) {
    if (typeof x?.[field] !== "string") throw new Error(`${where}: ${field} must be a string`);
  }
  if (x.answer === undefined || x.answer === null) throw new Error(`${where}: answer is missing`);
  for (const field of ["haystack_session_ids", "haystack_dates", "haystack_sessions", "answer_session_ids"]) {
    if (!Array.isArray(x[field])) throw new Error(`${where}: ${field} must be an array`);
  }
  const n = x.haystack_sessions.length;
  if (x.haystack_session_ids.length !== n || x.haystack_dates.length !== n) {
    throw new Error(`${where}: haystack_session_ids, haystack_dates and haystack_sessions differ in length`);
  }
  x.haystack_sessions.forEach((session, s) => {
    if (!Array.isArray(session)) throw new Error(`${where}: session ${s} is not a list of turns`);
    session.forEach((turn, t) => {
      if (typeof turn?.role !== "string" || typeof turn?.content !== "string") {
        throw new Error(`${where}: session ${s} turn ${t} needs a string role and content`);
      }
    });
  });
  parseSessionDate(x.question_date);
  x.haystack_dates.forEach(parseSessionDate);
}

/**
 * "2023/05/20 (Sat) 02:21" → "2023-05-20T02:21:00.000Z". The dataset gives no
 * time zone; UTC is as good as any, and the same one is used for every date.
 */
export function parseSessionDate(text) {
  const m = /^(\d{4})\/(\d{2})\/(\d{2})(?: \([A-Za-z]{3}\))? (\d{2}):(\d{2})$/.exec(text.trim());
  if (!m) throw new Error(`Unrecognised LongMemEval date: ${JSON.stringify(text)}`);
  const [, y, mo, d, h, mi] = m;
  const iso = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi)).toISOString();
  if (!iso.startsWith(`${y}-${mo}-${d}T${h}:${mi}`)) throw new Error(`Invalid LongMemEval date: ${JSON.stringify(text)}`);
  return iso;
}

/**
 * Which instances a run covers. With a limit, a stratified slice: one of each
 * question type in turn, in file order within a type, so `--limit 50` exercises
 * every type instead of the first 50 of whichever comes first in the file.
 * Deterministic; returned in file order.
 */
export function selectInstances(instances, { limit, types } = {}) {
  const wanted = types?.length ? instances.filter((x) => types.includes(x.question_type)) : instances;
  if (limit === undefined || limit >= wanted.length) return wanted;
  const byType = new Map();
  for (const t of QUESTION_TYPES) byType.set(t, []);
  for (const x of wanted) {
    if (!byType.has(x.question_type)) byType.set(x.question_type, []);
    byType.get(x.question_type).push(x);
  }
  const queues = [...byType.values()].filter((q) => q.length > 0);
  const chosen = new Set();
  for (let depth = 0; chosen.size < limit; depth += 1) {
    for (const q of queues) {
      if (chosen.size >= limit) break;
      if (depth < q.length) chosen.add(q[depth]);
    }
  }
  return wanted.filter((x) => chosen.has(x));
}

/**
 * The retrieval corpus exactly as the official retrieval code names it
 * (`process_item_flat_index`, turn granularity, src/retrieval/run_retrieval.py):
 * one id per USER turn, `<session id>_<1-based turn>`. In an evidence session
 * (its id contains "answer"), a user turn without `has_answer` has "answer"
 * renamed to "noans", so the correct documents are exactly the ids that still
 * contain "answer". The renaming is kept verbatim because the session-level
 * metric is computed from these ids.
 */
export function corpusOf(instance) {
  const corpus = [];
  instance.haystack_sessions.forEach((session, s) => {
    const sessionId = instance.haystack_session_ids[s];
    session.forEach((turn, t) => {
      if (turn.role !== "user") return;
      const id = `${sessionId}_${t + 1}`;
      const renamed = sessionId.includes("answer") && !turn.has_answer ? id.replaceAll("answer", "noans") : id;
      corpus.push({ id: renamed, session: s, turn: t });
    });
  });
  const correct = [...new Set(corpus.map((c) => c.id).filter((id) => id.includes("answer")))];
  return { corpus, correct };
}

/**
 * Whether the official retrieval averages count this instance: abstention
 * questions are skipped, and so is any question with no evidence on the user's
 * side of the history (the official script's "no target turns from the user side").
 */
export function retrievalSkipReason(instance) {
  if (isAbstention(instance.question_id)) return "abstention";
  const hasTarget = instance.haystack_sessions.some((session) => session.some((turn) => turn.role === "user" && turn.has_answer));
  return hasTarget ? null : "no-user-evidence";
}
