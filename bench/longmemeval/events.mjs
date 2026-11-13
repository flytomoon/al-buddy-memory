/** Flagged write-time event prototype. Raw turns remain the source of truth. */
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { parseSessionDate } from "./dataset.mjs";

const STOP = new Set("the and for with from this that what when where which have about many much did does were was are you your their they them into over under last first time times week month year years days day how who why all any each between since before after most more my our its".split(" "));
const words = (text) => new Set((text.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []).filter((w) => !STOP.has(w)));
const validDay = (value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().startsWith(value);

export function validateEvents(text, session, observationDate) {
  let parsed;
  try { parsed = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, "").trim()); }
  catch (e) { throw new Error(`Event extraction returned invalid JSON: ${e.message}`); }
  if (!Array.isArray(parsed) || parsed.length > 100) throw new Error("Event extraction must return an array of at most 100 events");
  return parsed.map((event, i) => {
    const turn = session[event?.turn];
    if (!Number.isInteger(event?.turn) || !turn || typeof event.quote !== "string" || !event.quote.trim() || !turn.content.includes(event.quote)) throw new Error(`Event ${i}: quote must occur verbatim in its source turn`);
    if (typeof event.entity !== "string" || !event.entity.trim() || typeof event.aspect !== "string" || !event.aspect.trim()) throw new Error(`Event ${i}: entity and aspect are required`);
    if (event.referencedDate !== null && !validDay(event.referencedDate)) throw new Error(`Event ${i}: referencedDate must be an absolute YYYY-MM-DD date or null`);
    return { turn: event.turn, quote: event.quote, entity: event.entity.trim(), aspect: event.aspect.trim(), observedDate: observationDate.slice(0, 10), referencedDate: event.referencedDate };
  });
}

/** Cached by full source session; failed calls are never cached or silently skipped. */
export function sessionExtractor(answerer, { cachePath } = {}) {
  const cache = new Map();
  if (cachePath && existsSync(cachePath)) for (const line of readFileSync(cachePath, "utf8").split("\n").filter(Boolean)) {
    const row = JSON.parse(line);
    if (row.key && Array.isArray(row.events)) cache.set(row.key, row.events);
  }
  return async (session, sessionDate) => {
    const observed = parseSessionDate(sessionDate);
    const key = createHash("sha256").update(JSON.stringify({ session, observed, schema: 1 })).digest("hex");
    if (cache.has(key)) return validateEvents(JSON.stringify(cache.get(key)), session, observed);
    const prompt = `Extract concrete events from these turns. Return only a JSON array. Each item: {"turn": zero-based turn index, "quote": exact contiguous substring from that turn, "entity": person/place/thing involved, "aspect": activity or attribute, "referencedDate": absolute YYYY-MM-DD date or null}. Resolve relative dates against observation date ${observed.slice(0, 10)}. Use null when no event date is stated. Do not invent events or dates. At most 100 events.\nTurns:\n${JSON.stringify(session.map((t, i) => ({ turn: i, role: t.role, content: t.content })))}`;
    const result = await answerer.complete(prompt);
    const events = validateEvents(result.text, session, observed);
    cache.set(key, events);
    if (cachePath) appendFileSync(cachePath, `${JSON.stringify({ key, events })}\n`);
    return events;
  };
}

/** Entity/aspect overlap and a date range gather source turns independently of vector similarity. */
export function eventSources(events, question, windows = [], limit = 30) {
  const query = words(question);
  const matched = events.map((event) => {
    const overlap = [...words(`${event.entity} ${event.aspect}`)].filter((w) => query.has(w)).length;
    const date = event.referencedDate ?? event.observedDate;
    const inWindow = windows.length === 0 || windows.some((w) => date >= w.from.slice(0, 10) && date < w.to.slice(0, 10));
    return { event, overlap, inWindow };
  }).filter((x) => x.overlap > 0 && x.inWindow);
  matched.sort((a, b) => b.overlap - a.overlap || a.event.observedDate.localeCompare(b.event.observedDate));
  return [...new Set(matched.slice(0, limit).map((x) => x.event.sourceId))];
}
