/**
 * Derived state over evolving data: when the answer is not stored anywhere and
 * has to be worked out from several things said over time (a count, a total,
 * a set after adds and removes, a sequence of states, the latest value), does
 * recall hand the reader every event it needs?
 *
 * Built for docs/research/memderive-2026-10.md, to test one claim from the
 * MemDerive paper (arXiv 2610.25373) as it was described to us: that memory
 * systems trail plain BM25 on derived state. The paper and its code could not
 * be read where this was written, so the dataset (cases.json) is our own, not
 * a replica of theirs.
 *
 * Retrieval only, scored by identity: every memory carries the id of the event
 * it came from, every question names the events it needs, and nothing reads or
 * answers the question. The same items (events, near-miss distractors, and
 * filler: real user turns from LongMemEval) go into one store and one BM25
 * index, and every system is asked every question:
 *
 *   - al-buddy: HybridRetriever with the on-device embedder, recalled as the
 *     MCP recall tool recalls (`validAt` now, `expand: true`).
 *   - al-buddy-keyword: the same recall with no embedder (keyword list only).
 *   - fts: the store's own keyword search (`searchNodes`), no fusion, no expand.
 *   - bm25: Okapi BM25 over the same texts, words as SQLite's unicode61 splits
 *     them, no stemming, no stopwords.
 *   - bm25-stem: the same with Lucene's English stopwords, possessives dropped
 *     and Porter stemming: what Pyserini's default BM25 baseline reads.
 *
 * The library is passed in (`lib`), so the runner uses the built package and
 * the tests use the source.
 */
import { readFileSync } from "node:fs";

import { porterStem } from "./porter.mjs";

export const FAMILIES = ["latest", "count", "sum", "set", "history", "composite"];
export const SYSTEMS = ["al-buddy", "al-buddy-keyword", "fts", "bm25", "bm25-stem"];
/** Every k a ranking is scored at; rankings are read this deep. */
export const KS = [5, 10, 20];
/** A question may need at most this many events: the MCP recall tool's default page is 8. */
export const MAX_NEEDS = 8;
/** Stop a run after this many failures in a row: something is broken, not one question. */
export const MAX_CONSECUTIVE_FAILURES = 3;

const instant = (at) => new Date(at.length === 10 ? `${at}T00:00:00.000Z` : at).toISOString();

export function loadCases(path) {
  const cases = JSON.parse(readFileSync(path, "utf8"));
  checkCases(cases);
  return cases;
}

/** Throws on anything that would make a score meaningless. */
export function checkCases(cases) {
  if (!cases.now || Number.isNaN(Date.parse(cases.now))) throw new Error("cases.now must be an instant");
  const now = instant(cases.now);
  const events = new Set();
  const ids = new Set();
  const add = (id, at, what) => {
    if (typeof id !== "string" || id === "") throw new Error(`${what} without an id`);
    if (ids.has(id)) throw new Error(`duplicate id ${id}`);
    ids.add(id);
    if (typeof at !== "string" || Number.isNaN(Date.parse(at))) throw new Error(`${id}: bad date ${at}`);
    if (instant(at) > now) throw new Error(`${id} is dated after now (${cases.now})`);
  };
  for (const s of cases.subjects) {
    if (!s.events?.length) throw new Error(`subject ${s.id}: no events`);
    for (const e of s.events) {
      add(e.id, e.at, "event");
      events.add(e.id);
    }
    for (const d of s.distractors ?? []) add(d.id, d.at, "distractor");
  }
  const questionIds = new Set();
  for (const s of cases.subjects) {
    for (const q of s.questions ?? []) {
      if (questionIds.has(q.id)) throw new Error(`duplicate question id ${q.id}`);
      questionIds.add(q.id);
      if (!FAMILIES.includes(q.family)) throw new Error(`question ${q.id}: unknown family "${q.family}"`);
      if (!q.needs?.length) throw new Error(`question ${q.id}: needs no events`);
      if (q.needs.length > MAX_NEEDS) throw new Error(`question ${q.id}: needs ${q.needs.length} events, more than ${MAX_NEEDS}`);
      if (new Set(q.needs).size !== q.needs.length) throw new Error(`question ${q.id}: an event is needed twice`);
      for (const id of q.needs) if (!events.has(id)) throw new Error(`question ${q.id}: needs ${id}, which is not an event`);
      for (const [id, older] of Object.entries(q.supersedes ?? {})) {
        if (!q.needs.includes(id)) throw new Error(`question ${q.id}: supersedes names ${id}, which it does not need`);
        if (!older.length) throw new Error(`question ${q.id}: ${id} supersedes nothing`);
        for (const o of older) {
          if (!events.has(o)) throw new Error(`question ${q.id}: ${o} is not an event`);
          if (q.needs.includes(o)) throw new Error(`question ${q.id}: ${o} is both needed and superseded`);
        }
      }
    }
  }
  if (questionIds.size === 0) throw new Error("no questions");
}

/** Every event and distractor as one item, oldest first. */
export function itemsOf(cases) {
  const items = cases.subjects.flatMap((s) => [
    ...s.events.map((e) => ({ id: e.id, at: instant(e.at), text: e.text, kind: "event" })),
    ...(s.distractors ?? []).map((d) => ({ id: d.id, at: instant(d.at), text: d.text, kind: "distractor" })),
  ]);
  return items.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : 1));
}

export function questionsOf(cases) {
  return cases.subjects.flatMap((s) => (s.questions ?? []).map((q) => ({ ...q, subject: s.id, supersedes: q.supersedes ?? {} })));
}

/** A small deterministic PRNG (mulberry32), so a seed names the same filler on every machine. */
function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * `count` user turns from LongMemEval haystacks, deduplicated, 40-800 characters
 * (pasted documents left out), picked by `seed` and dated evenly from `from` to
 * `to`, so they share the evidence's period.
 */
export function fillerFrom(instances, { count, seed = 1, from, to }) {
  if (!Number.isInteger(count) || count < 0) throw new Error(`filler count must be an integer >= 0 (got ${count})`);
  if (count === 0) return [];
  const seen = new Set();
  const pool = [];
  for (const instance of instances) {
    for (const session of instance.haystack_sessions ?? []) {
      for (const turn of session) {
        if (turn.role !== "user" || typeof turn.content !== "string") continue;
        const text = turn.content.trim();
        if (text.length < 40 || text.length > 800 || seen.has(text)) continue;
        seen.add(text);
        pool.push(text);
      }
    }
  }
  if (pool.length < count) throw new Error(`asked for ${count} filler turns; the dataset has ${pool.length} that qualify`);
  const rand = random(seed);
  for (let i = pool.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const start = Date.parse(instant(from));
  const span = Date.parse(instant(to)) - start;
  return pool.slice(0, count).map((text, i) => ({ id: `filler-${i + 1}`, at: new Date(start + Math.floor((span * i) / count)).toISOString(), text, kind: "filler" }));
}

// ---------------------------------------------------------------------------
// BM25

/** Lucene's English stopword set (EnglishAnalyzer.ENGLISH_STOP_WORDS_SET). */
export const LUCENE_STOPWORDS = new Set(
  "a an and are as at be but by for if in into is it no not of on or such that the their then there these they this to was will with".split(" "),
);

/** Words as SQLite FTS5's unicode61 tokenizer splits them, lowercased. */
export function plainTokens(text) {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
}

/** Lucene-style English analysis: possessive 's dropped, stopwords removed, Porter-stemmed. */
export function stemmedTokens(text) {
  const words = text.toLowerCase().replace(/[’']s\b/gu, "").match(/[\p{L}\p{N}]+/gu) ?? [];
  return words.filter((w) => !LUCENE_STOPWORDS.has(w)).map(porterStem);
}

/**
 * Okapi BM25 (k1 1.2, b 0.75, Lucene's always-positive idf) over `docs`.
 * `search` returns ids, best first; a tie goes to the earlier document, and a
 * document matching no query term is never returned.
 */
export class Bm25Index {
  constructor(docs, analyze, { k1 = 1.2, b = 0.75 } = {}) {
    this.analyze = analyze;
    this.k1 = k1;
    this.b = b;
    this.ids = docs.map((d) => d.id);
    this.lengths = [];
    this.postings = new Map(); // term -> [docIndex, tf][]
    docs.forEach((d, i) => {
      const terms = analyze(d.text);
      this.lengths.push(terms.length);
      const tf = new Map();
      for (const t of terms) tf.set(t, (tf.get(t) ?? 0) + 1);
      for (const [t, n] of tf) {
        if (!this.postings.has(t)) this.postings.set(t, []);
        this.postings.get(t).push([i, n]);
      }
    });
    this.avgLength = this.lengths.reduce((s, n) => s + n, 0) / Math.max(1, docs.length);
  }

  idf(term) {
    const df = this.postings.get(term)?.length ?? 0;
    const n = this.ids.length;
    return Math.log(1 + (n - df + 0.5) / (df + 0.5));
  }

  /** Document index -> score, for every document matching a query term. */
  scores(query) {
    const scores = new Map();
    for (const term of this.analyze(query)) {
      const postings = this.postings.get(term);
      if (!postings) continue;
      const idf = this.idf(term);
      for (const [i, tf] of postings) {
        const norm = this.k1 * (1 - this.b + (this.b * this.lengths[i]) / (this.avgLength || 1));
        scores.set(i, (scores.get(i) ?? 0) + (idf * tf * (this.k1 + 1)) / (tf + norm));
      }
    }
    return scores;
  }

  search(query, limit) {
    return [...this.scores(query).entries()]
      .sort((x, y) => y[1] - x[1] || x[0] - y[0])
      .slice(0, limit)
      .map(([i]) => this.ids[i]);
  }
}

// ---------------------------------------------------------------------------
// The memory

/** Wait for the clock to move, so "most recently learned" never ties on a millisecond. */
function nextMillisecond() {
  const t = Date.now();
  while (Date.now() === t) {
    /* spin: at most a millisecond */
  }
}

/** One item as the MCP remember tool stores a plain fact, dated when it was said. */
const plainFact = (item) => ({
  provenance: "UserInput",
  encryptionKeyRef: "memderive",
  memoryType: "Experience",
  privacyClassification: "Private",
  retentionTier: "FullRetention",
  content: { text: item.text },
  contextualMetadata: { benchId: item.id },
  confidenceWeight: 1,
  decayRate: 0,
  validFrom: item.at,
});

/** A fresh in-memory store holding every item, told in date order, embedded when an embedder is given. */
export async function buildStore(lib, items, { embedder } = {}) {
  const store = new lib.SqliteMemoryStore(":memory:");
  try {
    for (const item of [...items].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))) {
      nextMillisecond();
      await store.addNode(plainFact(item));
    }
    if (embedder) {
      const indexed = await lib.indexMissingEmbeddings(store, embedder);
      if (indexed !== items.length) throw new Error(`embedded ${indexed} of ${items.length} items`);
    }
    return store;
  } catch (err) {
    store.close();
    throw err;
  }
}

const benchIdOf = (node) => {
  const id = node.contextualMetadata?.["benchId"];
  if (typeof id !== "string") throw new Error(`recall returned node ${node.nodeId}, which carries no benchId`);
  return id;
};

/**
 * One ranker per system: `(question text) => ids, best first`, read
 * `depth` deep. A system that cannot run is listed in `skipped` with the reason.
 */
export function makeRankers(lib, store, items, { now, embedder, systems = SYSTEMS, depth = Math.max(...KS) } = {}) {
  const validAt = instant(now);
  const rankers = {};
  const skipped = {};
  for (const system of systems) {
    if (!SYSTEMS.includes(system)) throw new Error(`unknown system "${system}"`);
    if (system === "al-buddy") {
      if (!embedder) {
        skipped[system] = "needs an embedder (--embedder local): the MCP recall tool runs hybrid recall";
        continue;
      }
      const retriever = new lib.HybridRetriever(store, embedder);
      rankers[system] = async (q) => (await retriever.recall(q, { limit: depth, validAt, expand: true })).map(benchIdOf);
    } else if (system === "al-buddy-keyword") {
      const retriever = new lib.HybridRetriever(store);
      rankers[system] = async (q) => (await retriever.recall(q, { limit: depth, validAt, expand: true })).map(benchIdOf);
    } else if (system === "fts") {
      rankers[system] = async (q) => (await store.searchNodes({ query: q, limit: depth, validAt })).map(benchIdOf);
    } else {
      const index = new Bm25Index(items, system === "bm25" ? plainTokens : stemmedTokens);
      rankers[system] = async (q) => index.search(q, depth);
    }
  }
  return { rankers, skipped };
}

// ---------------------------------------------------------------------------
// Scoring

/**
 * At each k: `full` (every needed event in the first k), `recall` (the share of
 * them there) and, for a question with superseded values, `currentFirst`: every
 * needed value that replaced older ones is in the first k and ranks above each
 * of them that is.
 */
export function scoreRanking(ranked, question, ks = KS) {
  const out = {};
  for (const k of ks) {
    const top = ranked.slice(0, k);
    const rank = (id) => top.indexOf(id);
    const found = question.needs.filter((id) => top.includes(id)).length;
    const entry = { full: found === question.needs.length, recall: found / question.needs.length };
    const replaced = Object.entries(question.supersedes);
    if (replaced.length > 0) {
      entry.currentFirst = replaced.every(([id, older]) => rank(id) >= 0 && older.every((o) => rank(o) < 0 || rank(o) > rank(id)));
    }
    out[k] = entry;
  }
  return out;
}

/**
 * Ask every question of every ranker. A failed recall is recorded on its row
 * with its own message, never as an empty ranking; after
 * MAX_CONSECUTIVE_FAILURES failures in a row the run stops and says so.
 */
export async function runQuestions(questions, rankers, { ks = KS, log = () => {} } = {}) {
  const rows = [];
  let attempted = 0;
  let succeeded = 0;
  let streak = 0;
  let aborted = null;
  outer: for (const q of questions) {
    for (const [system, rank] of Object.entries(rankers)) {
      attempted += 1;
      const started = performance.now();
      try {
        const ranked = await rank(q.text);
        const ms = Math.round((performance.now() - started) * 10) / 10;
        rows.push({ system, question: q.id, family: q.family, ranked, ms, scores: scoreRanking(ranked, q, ks) });
        succeeded += 1;
        streak = 0;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        rows.push({ system, question: q.id, family: q.family, error: message });
        log(`${system} / ${q.id}: ${message}`);
        streak += 1;
        if (streak >= MAX_CONSECUTIVE_FAILURES) {
          aborted = `stopped after ${streak} failures in a row (last: ${system} / ${q.id}: ${message})`;
          break outer;
        }
      }
    }
  }
  return { rows, attempted, succeeded, failed: attempted - succeeded, aborted };
}

const round4 = (x) => Math.round(x * 10_000) / 10_000;

/** Rates over the scored rows of one system, at every k. */
export function rates(rows, ks = KS) {
  const scored = rows.filter((r) => r.scores);
  const out = { n: scored.length };
  for (const k of ks) {
    const withStale = scored.filter((r) => r.scores[k].currentFirst !== undefined);
    out[k] = {
      full: scored.length ? round4(scored.filter((r) => r.scores[k].full).length / scored.length) : null,
      recall: scored.length ? round4(scored.reduce((s, r) => s + r.scores[k].recall, 0) / scored.length) : null,
      currentFirst: withStale.length ? round4(withStale.filter((r) => r.scores[k].currentFirst).length / withStale.length) : null,
      currentFirstN: withStale.length,
    };
  }
  return out;
}

/** Per system: every question, then each family. */
export function summarize(rows, systems, ks = KS) {
  const out = {};
  for (const system of systems) {
    const mine = rows.filter((r) => r.system === system);
    if (mine.length === 0) continue;
    out[system] = { all: rates(mine, ks), ...Object.fromEntries(FAMILIES.map((f) => [f, rates(mine.filter((r) => r.family === f), ks)])) };
  }
  return out;
}

/** Questions where `a` has every needed event in the first k and `b` does not (wins), and the reverse (losses). */
export function compare(rows, a, b, k) {
  const by = (system) => new Map(rows.filter((r) => r.system === system && r.scores).map((r) => [r.question, r]));
  const ra = by(a);
  const rb = by(b);
  const wins = [];
  const losses = [];
  for (const [question, x] of ra) {
    const y = rb.get(question);
    if (!y) continue;
    if (x.scores[k].full && !y.scores[k].full) wins.push(question);
    if (!x.scores[k].full && y.scores[k].full) losses.push(question);
  }
  return { a, b, k, wins, losses };
}
