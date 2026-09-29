/**
 * What a recall query says about time and counting — read with rules, no model
 * call, so the same question at the same moment always reads the same way.
 *
 * "How many times did I bake in the past two weeks?" is answered from several
 * memories, usually from different conversations, and the words that make it
 * so are the words that make a plain search worse: "weeks" matches every note
 * that mentions weeks, and one vector for "jogging and yoga" lands between the
 * two. `analyzeQuery` pulls the question apart: the cues (counting, "now",
 * "first", a period of time resolved to dates), the question without its time
 * words, and one sub-query per thing it names together. `HybridRetriever`'s
 * `expand` option recalls with them; a host can use `aggregation` to show a
 * reader more memories, and to ask it to list them before it counts.
 *
 * Every rule here is English, and deliberately plain: a cue it misses leaves
 * recall exactly as it was without `expand`, and a period it resolves only
 * favours memories from then — it never hides the others.
 */
import { canonicalInstant } from "./instant.js";

export interface TimeWindow {
  /** Inclusive start (ISO instant), slack included. */
  from: string;
  /** Exclusive end (ISO instant), slack included. */
  to: string;
  /** The words that set it, as written in the query. */
  phrase: string;
}

export interface QueryCues {
  /** Counting, totalling, comparing, ordering or listing across memories ("how many", "total", "which … first"). */
  aggregation: boolean;
  /** Asks where something stands now ("currently", "so far", "most recently"). */
  current: boolean;
  /** Asks for the earliest or the latest of several ("first", "initially" / "last time", "latest"); null when neither or both. */
  order: "earliest" | "latest" | null;
  /** Periods the query names, resolved against `now` and widened by slack (see `WINDOW_SLACK_DAYS`). */
  windows: TimeWindow[];
  /** The query without its time phrases; null when it had none. */
  withoutTime: string | null;
  /** One sub-query per thing the query names together ("A, B and C", "X compared to Y"); empty unless it names two or more. */
  parts: string[];
  /** The cue words found, lower-cased, for explaining a recall. */
  matched: string[];
}

/**
 * Slack around a resolved period, in days: a memory is often recorded a few
 * days after what it tells ("I went to that workshop last Tuesday"), and now
 * and then a few days before (a plan).
 */
export const WINDOW_SLACK_DAYS = { before: 3, after: 7 } as const;

const DAY = 86_400_000;
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const MONTH = `(${MONTHS.join("|")})`;
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const NUMBER_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  "a couple of": 2, "couple of": 2, "a few": 3, few: 3, several: 3,
};
const NUM = `(\\d{1,3}|a couple of|couple of|a few|few|several|an|a|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)`;
const LEAD = `(?:(?:in|during|over|for|within|throughout|from)\\s+)?(?:the\\s+)?`;
/**
 * Not "my previous year's time" (a possessive names a thing) or "the last day
 * of my trip" (a part of something else): neither is a period before now.
 */
const NOT_A_PERIOD = `(?!['’]s\\b)(?!\\s+of\\b)`;
/**
 * Words matched with either case of their first letter, for the rules that
 * stay case-sensitive so that "May" the month is not "may" the verb: "Since
 * March, …" opens a sentence as often as "… since March" ends one.
 */
const either = (words: string) => words.split("|").map((w) => `[${w[0]!.toUpperCase()}${w[0]}]${w.slice(1)}`).join("|");

type Unit = "day" | "week" | "weekend" | "month" | "year";

const utc = (y: number, m: number, d: number) => Date.UTC(y, m, d);
const startOfDay = (t: number) => {
  const d = new Date(t);
  return utc(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
};
/** `n` calendar months on (or back), the day clamped to the month's last: 30 May less three months is 28 February, not 2 March. */
const addMonths = (t: number, n: number) => {
  const d = new Date(t);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n + 1, 0)).getUTCDate();
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, Math.min(d.getUTCDate(), lastDay), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds());
};
const back = (t: number, n: number, unit: Unit) =>
  unit === "day" ? t - n * DAY : unit === "week" || unit === "weekend" ? t - 7 * n * DAY : unit === "month" ? addMonths(t, -n) : addMonths(t, -12 * n);
/** Start of the calendar unit holding `t`; weeks start on Monday. */
function startOf(t: number, unit: Unit): number {
  const d = new Date(t);
  if (unit === "year") return utc(d.getUTCFullYear(), 0, 1);
  if (unit === "month") return utc(d.getUTCFullYear(), d.getUTCMonth(), 1);
  if (unit === "week") return startOfDay(t) - ((d.getUTCDay() + 6) % 7) * DAY;
  return startOfDay(t);
}
/** The most recent `weekday` (0 = Sunday) at or before `t` (strictly before with `strict`), at midnight. */
function lastWeekday(t: number, weekday: number, strict: boolean): number {
  const today = startOfDay(t);
  let diff = (new Date(today).getUTCDay() - weekday + 7) % 7;
  if (diff === 0 && strict) diff = 7;
  return today - diff * DAY;
}
const num = (word: string) => (/^\d+$/.test(word) ? Number(word) : NUMBER_WORDS[word.toLowerCase()] ?? 1);
const unitOf = (word: string) => word.toLowerCase().replace(/s$/, "") as Unit;
/** The latest year in which this month (and day) has begun by `now`. */
function yearFor(now: number, month: number, day = 1): number {
  const y = new Date(now).getUTCFullYear();
  return utc(y, month, day) > now ? y - 1 : y;
}
const monthIndex = (name: string) => MONTHS.indexOf(name);

/**
 * A rule finds a time phrase and says which period it means, or null when the
 * words turn out not to name one ("May I …", "on Saturday mornings").
 */
interface Rule {
  re: RegExp;
  resolve(m: RegExpExecArray, now: number, before: string): [number, number] | null;
}

const RULES: Rule[] = [
  // "from July to October", "between March and May 2023" — the period begun most recently when no year is given
  {
    re: new RegExp(`\\b(?:${either("from|between")})\\s+${MONTH}(?:\\s+(\\d{4}))?\\s+(?:to|and|through|until|till)\\s+${MONTH}(?:\\s+(\\d{4}))?\\b`, "g"),
    resolve(m, now) {
      const a = monthIndex(m[1]!), b = monthIndex(m[3]!);
      const wraps = b < a ? 1 : 0; // "from November to February" runs into the next year
      const ya = m[2] ? Number(m[2]) : m[4] ? Number(m[4]) - wraps : yearFor(now, a);
      const yb = m[4] ? Number(m[4]) : ya + wraps;
      return [utc(ya, a, 1), utc(yb, b + 1, 1)];
    },
  },
  // "in the past two weeks", "the last 3 months", "over the past few days"
  {
    re: new RegExp(`\\b${LEAD}(?:past|last|previous|recent)\\s+${NUM}\\s+(day|week|month|year)s?\\b${NOT_A_PERIOD}`, "gi"),
    resolve: (m, now) => [back(now, num(m[1]!), unitOf(m[2]!)), now],
  },
  // "two weeks ago", "a month ago", "3 days ago"
  {
    re: new RegExp(`\\b${NUM}\\s+(day|week|month|year)s?\\s+ago\\b`, "gi"),
    resolve(m, now) {
      const n = num(m[1]!), unit = unitOf(m[2]!);
      return [back(now, n + 1, unit), Math.min(now, back(now, n - 1, unit))];
    },
  },
  // "last week" (the calendar one, and the days since); "the past month", "in the last month" (rolling); "last weekend"
  {
    re: new RegExp(`\\b(?:(?:in|during|over|for|within|throughout|from)\\s+)?(the\\s+)?(past|last|previous)\\s+(day|week|weekend|month|year)\\b${NOT_A_PERIOD}`, "gi"),
    resolve(m, now) {
      const unit = unitOf(m[3]!);
      if (unit === "weekend") return [lastWeekday(now, 6, true), now];
      if (m[1] || m[2]!.toLowerCase() === "past" || unit === "day") return [back(now, 1, unit), now];
      return [startOf(back(now, 1, unit), unit), now];
    },
  },
  // "this year", "so far this month", "since the start of the year" — not "this weekend", which is usually a plan
  {
    re: /\b(?:(?:in|during|over|for|within|throughout)\s+)?(?:(?:so far\s+)?this|the current)\s+(week|month|year)\b(?!['’]s\b)|\bsince the (?:start|beginning) of (?:the |this )?(week|month|year)\b/gi,
    resolve: (m, now) => [startOf(now, unitOf(m[1] ?? m[2]!)), now],
  },
  // "today", "this morning" — not "tonight" (a plan), and "before today" is all of the past, not a period
  {
    re: /\b(today|this morning|this afternoon)\b/gi,
    resolve: (_m, now, before) => (/\b(?:before|until|till|by|up to)\s+$/i.test(before) ? null : [startOfDay(now), now]),
  },
  { re: /\b(yesterday|last night)\b/gi, resolve: (_m, now) => [startOfDay(now) - DAY, startOfDay(now)] },
  // "2023/05/01", "2023-05-01"
  {
    re: /\b(\d{4})[/-](\d{1,2})[/-](\d{1,2})\b/g,
    resolve(m) {
      const t = utc(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
      return validDay(m[1]!, m[2]!, m[3]!) ? [t, t + DAY] : null;
    },
  },
  // "May 3rd", "on March 15, 2023", "the 3rd of May"
  {
    re: new RegExp(`\\b${MONTH}\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s+(\\d{4}))?|\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+of\\s+${MONTH}\\b(?:,?\\s+(\\d{4}))?`, "g"),
    resolve(m, now) {
      const month = monthIndex(m[1] ?? m[5]!), day = Number(m[2] ?? m[4]), year = m[3] ?? m[6];
      const y = year ? Number(year) : yearFor(now, month, day);
      if (!validDay(String(y), String(month + 1), String(day))) return null; // not "February 30"
      const t = utc(y, month, day);
      return [t, t + DAY];
    },
  },
  // "in April", "since March", "the month of February", "late December 2022"
  {
    re: new RegExp(
      `\\b(?:(${either("in|during|throughout|for|of|since|from|until|till|by|before|after|early|mid|late|last|this|next")})\\s+)?(?:[Tt]he\\s+month\\s+of\\s+)?(?:(?:early|mid|late)[- ])?${MONTH}\\b(?:,?\\s+(\\d{4}))?`,
      "g",
    ),
    resolve(m, now, before) {
      const [, word, name, year] = m;
      const prep = word?.toLowerCase();
      // "May" is a month only where a month can stand: "in May", "May 2023", "the month of May".
      if (name === "May" && !prep && !year && !/the month of $/i.test(before + m[0].slice(0, m[0].indexOf("May")))) return null;
      // "before May", "until May", "next May" — a boundary or a plan, not a period to favour.
      if (prep && /^(until|till|by|before|next)$/.test(prep)) return null;
      const month = monthIndex(name!);
      let y = year ? Number(year) : yearFor(now, month);
      // "last May", asked in May, is a year ago.
      if (!year && prep === "last" && utc(y, month + 1, 1) > now) y -= 1;
      const from = utc(y, month, 1);
      return prep && /^(since|from|after)$/.test(prep) ? [from, Math.max(now, from + DAY)] : [from, utc(y, month + 1, 1)];
    },
  },
  // "last Thursday", "on Monday" — not "on Saturday mornings" (a habit) or "Maundy Thursday" (a name)
  {
    re: /\b(last|past|this|on)\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b(?!\s+(?:mornings|afternoons|evenings|nights))/gi,
    resolve(m, now) {
      const day = lastWeekday(now, WEEKDAYS.indexOf(m[2]!.toLowerCase()), /^(last|past)$/i.test(m[1] ?? ""));
      return [day, day + DAY];
    },
  },
  // "the 7/22 trip", "on 5/3/2023" (month first) — not "1/2 cup"
  {
    re: /(?<![\d/])(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?(?![\d/])/g,
    resolve(m, now, before) {
      const month = Number(m[1]) - 1, day = Number(m[2]);
      if (month < 0 || month > 11 || day < 1 || day > 31) return null;
      if (!m[3] && !/\b(?:on|the|before|after|since|by|until|from|of)\s+$/i.test(before)) return null;
      const year = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : yearFor(now, month, day);
      if (!validDay(String(year), String(month + 1), String(day))) return null; // not "2/30"
      const t = utc(year, month, day);
      return [t, t + DAY];
    },
  },
  // "in 2022", "since 2021"
  {
    re: /\b(in|during|throughout|since)\s+((?:19|20)\d{2})\b/gi,
    resolve(m, now) {
      const from = utc(Number(m[2]), 0, 1);
      return m[1]!.toLowerCase() === "since" ? [from, Math.max(now, from + DAY)] : [from, utc(Number(m[2]) + 1, 0, 1)];
    },
  },
];

function validDay(y: string, m: string, d: string): boolean {
  const t = new Date(utc(Number(y), Number(m) - 1, Number(d)));
  return t.getUTCMonth() === Number(m) - 1 && t.getUTCDate() === Number(d);
}

const AGGREGATION = [
  /\bhow (?:many|much|often|long)\b/,
  /\b(?:in )?total\b/,
  /\b(?:in all|altogether|combined|overall|sum|average|across|number of|count|times|different|both|each|every|difference)\b/,
  /\b(?:the order of|in (?:the )?order|from (?:earliest|first) to)\b/,
  /\bcompared? (?:to|with)\b/,
  /\b(?:more|less|fewer|older|younger|longer|shorter|higher|lower|faster|slower|earlier|later|bigger|smaller|cheaper) than\b/,
  /\bthe (?:most|least|fewest)\b/,
  /\bwhich\b[^?]*\b(?:first|last|earlier|later|more|less|most|least)\b/,
  /\b(?:two|three|four|five|six|seven|eight|nine|ten)\s+(?:\w+\s+){0,2}?\w+s\b/,
];
const CURRENT = /\b(?:currently|current|now|nowadays|these days|at the moment|at present|so far|to date|still|anymore|lately|recently|up to now)\b|\bsince (?:i|we|my)\b/;
// Not "last week" (a period), "last name" or "you said last time" (the previous conversation, not the latest of several).
const LATEST = /\b(?:latest|most recent(?:ly)?|newest|last (?!(?:night|week|weekend|month|year|few|couple|\d+|two|three|four|five|six|seven|eight|nine|ten|sunday|monday|tuesday|wednesday|thursday|friday|saturday|name|names|time)\b)\w+)/;
// Not "previous": "our previous conversation" is how people point back at any earlier chat.
const EARLIEST = /\b(?:first|earliest|initially|originally|formerly|used to)\b/;

/** Words that say what kind of question it is, not what it is about. */
const STOP = new Set(
  (
    "how many much often long what which who whom whose when where why is are was were be been being am do does did done have has had " +
    "i me my mine myself we us our you your the a an of to in on at for from by with about into and or that this these those it its there " +
    "total number amount count times altogether combined overall sum different all both each every any some can could would should will just also " +
    "currently current now still ever far so recently lately"
  ).split(" "),
);
const words = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? [];
const contentWords = (text: string) => words(text).filter((w) => !STOP.has(w));

/**
 * The words of a query that say what it is about, lower-cased and in order —
 * its question words, pronouns and counting words dropped. A keyword search
 * reads a bounded number of words, and "how many times did I" would spend a
 * third of them. "" when nothing is left.
 */
export function keywordsOf(query: string): string {
  return contentWords(query).join(" ");
}

/** Coordination: "A, B, and C", "A or B", "A compared to B", "A as well as B" — not the comma in "1,000". */
const COORDINATION = /\s*,\s*(?:and|or)\s+|\s*;\s*|(?<!\d),\s*|\s*,(?!\d)\s*|\s+(?:and|or|as well as|versus|vs\.?|compared (?:to|with))\s+/i;
/** A quoted title or phrase is one thing even when it says "and" or holds a comma. */
const QUOTED = /(^|[\s:(])(['"‘“])([^'"‘’“”]+?)(['"’”])(?=[\s,.?!:;)]|$)/g;
const MAX_PARTS = 6;

/**
 * Read a recall query for time and counting cues. `now` is the moment the
 * question is asked, which relative phrases ("last week") are resolved
 * against; it defaults to the current time.
 */
export function analyzeQuery(query: string, { now = new Date() }: { now?: string | number | Date } = {}): QueryCues {
  // A string is held to the store's own rule for instants: an ISO date, or a date-time WITH
  // a zone. A zone-less time would resolve "last week" in whatever zone the machine is in.
  const at = typeof now === "number" ? now : typeof now === "string" ? Date.parse(canonicalInstant(now, "analyzeQuery: now")) : now.getTime();
  if (!Number.isFinite(at)) throw new Error(`analyzeQuery: now is not a valid instant (got ${String(now)})`);

  // Time phrases first: each rule sees the text with earlier rules' phrases blanked out.
  let working = query;
  const windows: TimeWindow[] = [];
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    for (let m = rule.re.exec(working); m !== null; m = rule.re.exec(working)) {
      const span = rule.resolve(m, at, working.slice(0, m.index));
      if (!span) continue;
      const [from, to] = span;
      windows.push({
        from: new Date(from - WINDOW_SLACK_DAYS.before * DAY).toISOString(),
        to: new Date(Math.max(to, from + DAY) + WINDOW_SLACK_DAYS.after * DAY).toISOString(),
        phrase: query.slice(m.index, m.index + m[0].length).trim(),
      });
      working = working.slice(0, m.index) + " ".repeat(m[0].length) + working.slice(m.index + m[0].length);
    }
  }
  const withoutTime = windows.length > 0 ? working.replace(/\s+/g, " ").replace(/\s+([?.!,;:])/g, "$1").trim() : null;
  const text = (withoutTime ?? query).toLowerCase();

  const matched: string[] = [];
  const find = (re: RegExp) => {
    const m = re.exec(text);
    if (m) matched.push(m[0].trim());
    return m !== null;
  };
  const aggregation = AGGREGATION.map(find).some(Boolean);
  const current = find(CURRENT);
  const latest = find(LATEST);
  const earliest = find(EARLIEST);
  const order = (latest || current) && !earliest ? "latest" : earliest && !latest && !current ? "earliest" : null;

  return { aggregation, current, order, windows, withoutTime, parts: coordinatedParts(withoutTime ?? query), matched: [...new Set(matched)] };
}

/**
 * One sub-query per coordinated thing. A one-word one after the first borrows
 * the first one's words but its last — the head the coordination shares — so
 * "hours of jogging and yoga" asks for "yoga hours", not just "yoga".
 */
function coordinatedParts(text: string): string[] {
  const quoted: string[] = [];
  const masked = text.replace(QUOTED, (_all, lead: string, _open, inner: string) => `${lead}\u0000${quoted.push(inner) - 1}\u0000`);
  const unmask = (s: string) => s.replace(/\u0000(\d+)\u0000/g, (_all, i: string) => `"${quoted[Number(i)]}"`);
  const raw = masked
    .replace(/[?!.]+\s*$/, "")
    .split(COORDINATION)
    .map((p) => unmask(p).trim())
    .filter((p) => contentWords(p).length > 0);
  if (raw.length < 2) return [];
  const head = contentWords(raw[0]!).slice(0, -1);
  return raw.slice(0, MAX_PARTS).map((part, i) => {
    if (i === 0 || contentWords(part).length >= 2) return part;
    const own = new Set(contentWords(part));
    return [part, ...head.filter((w) => !own.has(w))].join(" ");
  });
}

/** Whether an instant falls in any of the windows. */
export function inWindows(instant: string, windows: readonly TimeWindow[]): boolean {
  const t = Date.parse(instant);
  return Number.isFinite(t) && windows.some((w) => t >= Date.parse(w.from) && t < Date.parse(w.to));
}
