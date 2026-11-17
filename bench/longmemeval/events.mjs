/**
 * Flagged write-time event study (review 2026-11-17, § 3 item 2 and § 4.3).
 * Raw turns remain the source of truth: an event is a derived record that
 * quotes its source turn verbatim and points at it; recall may use it to rank
 * the source turn, and the reader is only ever shown raw rounds.
 *
 * - One bad event (a paraphrased quote, a missing turn, an impossible date) is
 *   dropped and counted with its reason; it never fails its session or question.
 * - A session whose response is not a JSON array at all is a failed session: it
 *   is recorded with its reason, never cached (a rerun retries it), and its
 *   questions run with no events from it, which the result counts.
 * - Extraction runs as its own pass over the unique sessions of the selected
 *   questions, `concurrency` wide, resumable from the cache, and stops after 3
 *   consecutive failed sessions or at a usage limit.
 */
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { UsageLimitError } from "./answerers.mjs";
import { parseSessionDate } from "./dataset.mjs";

/** Bumped when the prompt or the cached shape changes, so an old cache is never read as a new one. */
export const EVENT_SCHEMA = 2;
export const MAX_EVENTS_PER_SESSION = 100;
/** The library's own reciprocal-rank-fusion constant (src/hybrid-retriever.ts, RRF_K). */
export const EVENT_RRF_K = 60;

const STOP = new Set("the and for with from this that what when where which have about many much did does were was are you your their they them into over under last first time times week month year years days day how who why all any each between since before after most more my our its".split(" "));
const words = (text) => new Set((text.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []).filter((w) => !STOP.has(w)));
const validDay = (value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().startsWith(value);

/** The JSON array in a model's reply: bare, fenced, or the outermost `[ … ]` inside prose. Throws when there is none. */
function parseArray(text) {
  const stripped = String(text ?? "").replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, "").trim();
  let parsed;
  try {
    parsed = JSON.parse(stripped);
  } catch (first) {
    const open = stripped.indexOf("[");
    const close = stripped.lastIndexOf("]");
    if (open === -1 || close <= open) throw new Error(`Event extraction returned invalid JSON: ${first.message}`);
    try {
      parsed = JSON.parse(stripped.slice(open, close + 1));
    } catch (e) {
      throw new Error(`Event extraction returned invalid JSON: ${e.message}`);
    }
  }
  if (!Array.isArray(parsed)) throw new Error("Event extraction must return a JSON array");
  return parsed;
}

/** Why one event cannot be kept, or null when it can. */
function eventProblem(event, session) {
  if (event === null || typeof event !== "object" || Array.isArray(event)) return ["shape", "not an object"];
  if (!Number.isInteger(event.turn) || !session[event.turn]) return ["turn", `turn ${JSON.stringify(event.turn)} is not a turn of this session`];
  if (typeof event.quote !== "string" || !event.quote.trim()) return ["quote", "quote is empty"];
  if (!session[event.turn].content.includes(event.quote)) return ["quote", "quote does not occur verbatim in its source turn"];
  if (typeof event.entity !== "string" || !event.entity.trim() || typeof event.aspect !== "string" || !event.aspect.trim()) return ["entity-aspect", "entity and aspect are required"];
  const date = event.referencedDate ?? null;
  if (date !== null && !validDay(date)) return ["referencedDate", `referencedDate ${JSON.stringify(date)} is not an absolute YYYY-MM-DD date or null`];
  return null;
}

/**
 * Every usable event in a model's reply, and every unusable one with its
 * reason. Throws only when the reply holds no JSON array at all.
 */
export function validateEvents(text, session, observationDate) {
  const parsed = parseArray(text);
  const events = [];
  const dropped = [];
  parsed.forEach((event, index) => {
    if (index >= MAX_EVENTS_PER_SESSION) return void dropped.push({ index, reason: "cap", detail: `over the ${MAX_EVENTS_PER_SESSION}-event cap` });
    const problem = eventProblem(event, session);
    if (problem) return void dropped.push({ index, reason: problem[0], detail: problem[1] });
    events.push({ turn: event.turn, quote: event.quote, entity: event.entity.trim(), aspect: event.aspect.trim(), observedDate: observationDate.slice(0, 10), referencedDate: event.referencedDate ?? null });
  });
  return { events, dropped };
}

export function extractionPrompt(session, observed) {
  return `Extract concrete events from these turns. Return only a JSON array. Each item: {"turn": zero-based turn index, "quote": exact contiguous substring from that turn, "entity": person/place/thing involved, "aspect": activity or attribute, "referencedDate": absolute YYYY-MM-DD date or null}. Resolve relative dates against observation date ${observed.slice(0, 10)}. Use null when no event date is stated. Do not invent events or dates. At most ${MAX_EVENTS_PER_SESSION} events.\nTurns:\n${JSON.stringify(session.map((t, i) => ({ turn: i, role: t.role, content: t.content })))}`;
}

/** A session and its date, as the cache keys them. */
export function sessionKey(session, sessionDate) {
  return createHash("sha256").update(JSON.stringify({ session, observed: parseSessionDate(sessionDate), schema: EVENT_SCHEMA })).digest("hex");
}

/**
 * The extraction a run uses. `prepare(instances)` extracts every session of
 * those questions not yet in the cache; `lookup(session, date)` then reads the
 * result without a model call: `{ events, dropped }`, or `{ events: [],
 * dropped: [], failed: reason }` for a session whose extraction failed.
 * `stats` describes the whole pass, cached sessions included.
 */
export function sessionExtractor(answerer, { cachePath } = {}) {
  /** key → the model's raw reply, validated afresh on every read. */
  const cache = new Map();
  /** key → why its extraction failed, this process only (never cached). */
  const failures = new Map();
  let unreadableCacheLines = 0;
  if (cachePath && existsSync(cachePath)) {
    for (const line of readFileSync(cachePath, "utf8").split("\n").filter(Boolean)) {
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        unreadableCacheLines += 1; // a line cut short by a killed run: that session is extracted again
        continue;
      }
      if (row?.schema === EVENT_SCHEMA && typeof row.key === "string" && typeof row.text === "string" && !cache.has(row.key)) cache.set(row.key, row.text);
    }
  }
  const stats = { sessions: 0, cachedBefore: 0, called: 0, extracted: 0, failed: [], events: 0, dropped: 0, droppedByReason: {}, unreadableCacheLines };

  async function extract(session, sessionDate) {
    const key = sessionKey(session, sessionDate);
    if (cache.has(key)) return { key, cached: true, ...validateEvents(cache.get(key), session, parseSessionDate(sessionDate)) };
    const observed = parseSessionDate(sessionDate);
    const result = await answerer.complete(extractionPrompt(session, observed));
    const parsed = validateEvents(result.text, session, observed); // throws before caching when there is no array
    cache.set(key, result.text);
    if (cachePath) appendFileSync(cachePath, `${JSON.stringify({ key, schema: EVENT_SCHEMA, text: result.text })}\n`);
    return { key, cached: false, ...parsed };
  }

  function count(parsed) {
    stats.extracted += 1;
    stats.events += parsed.events.length;
    stats.dropped += parsed.dropped.length;
    for (const d of parsed.dropped) stats.droppedByReason[d.reason] = (stats.droppedByReason[d.reason] ?? 0) + 1;
  }

  /**
   * Extract every unique session of `instances`, `concurrency` at a time.
   * Throws (with `attempted`, `succeeded` and `stats`) at a usage limit or after
   * 3 consecutive failed sessions; the cache keeps what succeeded.
   */
  async function prepare(instances, { concurrency = 4, onSession = () => {} } = {}) {
    const unique = new Map();
    for (const x of instances) {
      x.haystack_sessions.forEach((session, s) => {
        const key = sessionKey(session, x.haystack_dates[s]);
        if (!unique.has(key)) unique.set(key, { session, date: x.haystack_dates[s], sessionId: x.haystack_session_ids[s] });
      });
    }
    stats.sessions = unique.size;
    const todo = [];
    for (const [key, item] of unique) {
      if (cache.has(key)) {
        stats.cachedBefore += 1;
        count(validateEvents(cache.get(key), item.session, parseSessionDate(item.date)));
      } else todo.push([key, item]);
    }
    let next = 0;
    let consecutive = 0;
    let stop = null;
    let attempted = 0;
    let succeeded = 0;
    let completed = 0;
    const worker = async () => {
      while (stop === null && next < todo.length) {
        const [key, item] = todo[next++];
        attempted += 1;
        stats.called += 1;
        let parsed;
        let reason = null;
        try {
          parsed = await extract(item.session, item.date);
        } catch (e) {
          if (e instanceof UsageLimitError) {
            stop ??= e;
            return;
          }
          reason = String(e?.message ?? e);
        }
        // Progress is reported outside the try, so a failing callback is never counted as a failed session.
        if (reason === null) {
          count(parsed);
          failures.delete(key);
          succeeded += 1;
          consecutive = 0;
          onSession({ sessionId: item.sessionId, ok: true, events: parsed.events.length, dropped: parsed.dropped.length, done: stats.cachedBefore + ++completed, of: unique.size });
        } else {
          failures.set(key, reason);
          stats.failed.push({ sessionId: item.sessionId, date: item.date, key, reason });
          consecutive += 1;
          if (consecutive >= 3) stop ??= new Error(`Stopped after 3 consecutive failed session extractions (last: ${reason})`);
          onSession({ sessionId: item.sessionId, ok: false, reason, done: stats.cachedBefore + ++completed, of: unique.size });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, todo.length)) }, worker));
    if (stop) throw Object.assign(stop, { attempted, succeeded, stats });
    return stats;
  }

  function lookup(session, sessionDate) {
    const key = sessionKey(session, sessionDate);
    if (cache.has(key)) return validateEvents(cache.get(key), session, parseSessionDate(sessionDate));
    if (failures.has(key)) return { events: [], dropped: [], failed: failures.get(key) };
    throw new Error("Session was not extracted: run prepare() over this question first");
  }

  return { extract, prepare, lookup, stats, describe: () => answerer.describe?.() ?? null };
}

/**
 * The event channel: source turns of events whose entity or aspect shares a
 * word with the question (and, when the question names a period, whose date
 * falls in it), best overlap first. Equal overlaps share a rank (the mean of
 * the positions they span), so no tie is broken by date or by chance.
 * Returns `[{ sourceId, overlap, rank }]`, at most `limit`.
 */
export function eventSources(events, question, windows = [], limit = Infinity) {
  const query = words(question);
  const best = new Map();
  for (const event of events) {
    const overlap = [...words(`${event.entity} ${event.aspect}`)].filter((w) => query.has(w)).length;
    if (overlap === 0) continue;
    const date = event.referencedDate ?? event.observedDate;
    if (windows.length > 0 && !windows.some((w) => date >= w.from.slice(0, 10) && date < w.to.slice(0, 10))) continue;
    if ((best.get(event.sourceId) ?? 0) < overlap) best.set(event.sourceId, overlap);
  }
  const ordered = [...best].map(([sourceId, overlap]) => ({ sourceId, overlap })).sort((a, b) => b.overlap - a.overlap);
  const out = [];
  for (let i = 0; i < ordered.length; ) {
    let j = i;
    while (j < ordered.length && ordered[j].overlap === ordered[i].overlap) j += 1;
    const rank = (i + 1 + j) / 2; // positions i+1 … j, 1-based
    for (let k = i; k < j; k += 1) out.push({ ...ordered[k], rank });
    i = j;
  }
  return out.slice(0, limit);
}

/**
 * Reciprocal-rank fusion of the recall hits (in their order) with the event
 * channel, equal weight, k = 60 as in the library: a node's score is
 * 1/(k + its hit rank) plus 1/(k + its event rank). Ties keep recall's order,
 * then the event channel's. `nodes` maps every event source id to its node.
 */
export function fuseEventSources(hits, sources, nodes, k = EVENT_RRF_K) {
  const entries = new Map();
  hits.forEach((node, i) => entries.set(node.nodeId, { node, score: 1 / (k + i + 1), hitRank: i + 1, eventRank: Infinity }));
  for (const s of sources) {
    const existing = entries.get(s.sourceId);
    if (existing) {
      existing.score += 1 / (k + s.rank);
      existing.eventRank = s.rank;
      continue;
    }
    const node = nodes.get(s.sourceId);
    if (!node) continue;
    entries.set(s.sourceId, { node, score: 1 / (k + s.rank), hitRank: Infinity, eventRank: s.rank });
  }
  return [...entries.values()].sort((a, b) => b.score - a.score || a.hitRank - b.hitRank || a.eventRank - b.eventRank).map((e) => e.node);
}
