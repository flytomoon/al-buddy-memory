/**
 * The stale-fact benchmark: when a fact changes, does recall return the value
 * that is true now — and, asked about a past instant, the value true then?
 *
 * The same statements go into the same store three ways, and the same
 * questions are asked of each:
 *
 *   - append-only: every statement kept as an ordinary fact. Nothing is ever
 *     closed — what a memory without invalidation holds.
 *   - append-only+freshness: the same store, recalled with `freshness: 1`, so
 *     the most recently LEARNED of the matching facts ranks higher.
 *   - current-state: each statement recorded with `recordState` under its
 *     subject and aspect, so a newer one closes the one it replaces
 *     (`validTo`), and recall returns what is valid at the instant asked.
 *
 * Scored by identity, not by string matching: every memory carries the id of
 * the statement it came from. The subject and aspect a statement belongs to are
 * given by the dataset; the benchmark does not measure whether a model would
 * have chosen that key, and it compares the library with itself, not with any
 * other system.
 *
 * The library is passed in (`lib`), so the runner uses the built package and
 * the tests use the source.
 */
import { readFileSync } from "node:fs";

export const STRATEGIES = ["append-only", "append-only+freshness", "current-state"];

export function loadCases(path) {
  const cases = JSON.parse(readFileSync(path, "utf8"));
  checkCases(cases);
  return cases;
}

const instant = (at) => new Date(at.length === 10 ? `${at}T00:00:00.000Z` : at).toISOString();

/** Throws on anything that would make a score meaningless: duplicate ids, a question before any statement, dates after `now`. */
export function checkCases(cases) {
  const ids = new Set();
  const now = instant(cases.now);
  for (const s of cases.subjects) {
    if (!s.statements?.length) throw new Error(`subject ${s.id}: no statements`);
    for (const st of s.statements) {
      if (ids.has(st.id)) throw new Error(`duplicate statement id ${st.id}`);
      ids.add(st.id);
      if (instant(st.at) > now) throw new Error(`statement ${st.id} is dated after now (${cases.now})`);
    }
    for (const q of s.questions) {
      if (!expectedAt(s, q.asOf ? instant(q.asOf) : now)) throw new Error(`subject ${s.id}: nothing is true yet at ${q.asOf ?? cases.now} ("${q.text}")`);
    }
  }
  for (const d of cases.distractors) if (instant(d.at) > now) throw new Error(`distractor "${d.text}" is dated after now`);
}

/** The statement of `subject` true at `at`: the latest one said to begin at or before it. */
export function expectedAt(subject, at) {
  return [...subject.statements].filter((st) => instant(st.at) <= at).sort((a, b) => instant(b.at).localeCompare(instant(a.at)))[0] ?? null;
}

/**
 * The order the memory hears things in: by date, then every statement marked
 * learnedLate (an old fact mentioned today), by date among themselves.
 */
export function ingestionOrder(cases) {
  const items = [
    ...cases.subjects.flatMap((s) => s.statements.map((st) => ({ kind: "statement", subject: s, statement: st, at: instant(st.at), late: st.learnedLate === true }))),
    ...cases.distractors.map((d, i) => ({ kind: "distractor", id: `distractor-${i + 1}`, text: d.text, at: instant(d.at), late: false })),
  ];
  const byDate = (a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0);
  return [...items.filter((x) => !x.late).sort(byDate), ...items.filter((x) => x.late).sort(byDate)];
}

/** Wait for the clock to move, so "most recently learned" never ties on a millisecond and never falls to a random id. */
function nextMillisecond() {
  const t = Date.now();
  while (Date.now() === t) {
    /* spin: at most a millisecond */
  }
}

const plainFact = (id, text, at) => ({
  provenance: "UserInput",
  encryptionKeyRef: "stale-facts",
  memoryType: "Experience",
  privacyClassification: "Private",
  retentionTier: "FullRetention",
  content: { text },
  contextualMetadata: { benchId: id },
  confidenceWeight: 1,
  decayRate: 0,
  validFrom: at,
});

/** A fresh store holding every statement and distractor, recorded the way `strategy` records them. */
export async function buildMemory(lib, cases, strategy, { embedder } = {}) {
  if (!STRATEGIES.includes(strategy)) throw new Error(`Unknown strategy "${strategy}"`);
  const store = new lib.SqliteMemoryStore(":memory:");
  for (const item of ingestionOrder(cases)) {
    nextMillisecond();
    if (item.kind === "distractor") {
      await store.addNode(plainFact(item.id, item.text, item.at));
    } else if (strategy === "current-state") {
      // Same provenance, type, confidence and decay as the plain facts: only validity differs.
      await lib.recordState(store, {
        subject: item.subject.subject,
        aspect: item.subject.aspect,
        text: item.statement.text,
        at: item.at,
        provenance: "UserInput",
        memoryType: "Experience",
        encryptionKeyRef: "stale-facts",
        contextualMetadata: { benchId: item.statement.id },
      });
    } else {
      await store.addNode(plainFact(item.statement.id, item.statement.text, item.at));
    }
  }
  if (embedder) await lib.indexMissingEmbeddings(store, embedder);
  return { store, retriever: new lib.HybridRetriever(store, embedder) };
}

/** Every question, with the statement that answers it and the ones that would be wrong. */
export function questionsOf(cases) {
  const now = instant(cases.now);
  return cases.subjects.flatMap((s) =>
    s.questions.map((q) => {
      const at = q.asOf ? instant(q.asOf) : now;
      const expected = expectedAt(s, at);
      return {
        subject: s.id,
        text: q.text,
        kind: q.asOf ? "as-of" : "now",
        validAt: at,
        lateArrival: s.statements.some((st) => st.learnedLate),
        expected: expected.id,
        wrong: s.statements.filter((st) => st.id !== expected.id).map((st) => st.id),
      };
    }),
  );
}

/** How one ranking scores: is the true statement first, in the top k, and is anything wrong in the top k? */
export function scoreRanking(ranked, question, k) {
  const top = ranked.slice(0, k);
  const wrongInTop = top.some((id) => question.wrong.includes(id));
  const expectedInTop = top.includes(question.expected);
  return {
    currentAt1: ranked[0] === question.expected,
    staleAt1: question.wrong.includes(ranked[0]),
    currentInTopK: expectedInTop,
    staleInTopK: wrongInTop,
    cleanTopK: expectedInTop && !wrongInTop,
  };
}

/** Ask every question of one strategy's memory. */
export async function runStrategy(lib, cases, strategy, { k = 5, embedder } = {}) {
  const memory = await buildMemory(lib, cases, strategy, { embedder });
  try {
    const rows = [];
    for (const q of questionsOf(cases)) {
      const hits = await memory.retriever.recall(q.text, { limit: k, validAt: q.validAt, ...(strategy === "append-only+freshness" ? { freshness: 1 } : {}) });
      const ranked = hits.map((n) => (typeof n.contextualMetadata["benchId"] === "string" ? n.contextualMetadata["benchId"] : n.nodeId));
      rows.push({ ...q, ranked, ...scoreRanking(ranked, q, k) });
    }
    return rows;
  } finally {
    memory.store.close();
  }
}

const METRICS = ["currentAt1", "staleAt1", "currentInTopK", "staleInTopK", "cleanTopK"];

/** Rates over a set of rows, as fractions with the count they are over. */
export function rates(rows) {
  const out = { n: rows.length };
  for (const m of METRICS) out[m] = rows.length ? Math.round((rows.filter((r) => r[m]).length / rows.length) * 10_000) / 10_000 : null;
  return out;
}

/** The published table: every question, "now" questions, as-of questions, and subjects with a late arrival. */
export function summarizeStrategy(rows) {
  return {
    all: rates(rows),
    now: rates(rows.filter((r) => r.kind === "now")),
    asOf: rates(rows.filter((r) => r.kind === "as-of")),
    lateArrival: rates(rows.filter((r) => r.lateArrival)),
  };
}
