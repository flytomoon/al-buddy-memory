/**
 * One LongMemEval history into a fresh memory, and recall against it — through
 * the library's public API only (`SqliteMemoryStore`, `HybridRetriever`,
 * `indexMissingEmbeddings`). The library is passed in (`lib`), so the runner
 * uses the built package and the tests use the source.
 *
 * Every message becomes one memory: the user's words as `UserInput`, the
 * assistant's as `AIInferred`, each a `Conversation` valid from its session's
 * date and tagged with its session. Nothing is summarised, extracted or
 * rewritten on the way in, and no model is called to build the memory: raw
 * text is the source of truth, which is the library's premise.
 */
import { corpusOf, parseSessionDate } from "./dataset.mjs";

/** How many memories one recall asks for: every candidate the keyword and vector lists can supply. */
export const RECALL_POOL = 100;

/**
 * A fresh in-memory SQLite store holding this instance's history. With an
 * embedder, every memory is embedded before the question is asked; with a
 * reranker, the retriever reorders what it finds with it.
 */
export async function ingestHistory(lib, instance, { embedder, reranker } = {}) {
  const store = new lib.SqliteMemoryStore(":memory:");
  /** nodeId → where the message sits in the history. */
  const origin = new Map();
  for (let s = 0; s < instance.haystack_sessions.length; s += 1) {
    const sessionId = instance.haystack_session_ids[s];
    const validFrom = parseSessionDate(instance.haystack_dates[s]);
    const session = instance.haystack_sessions[s];
    for (let t = 0; t < session.length; t += 1) {
      const turn = session[t];
      if (turn.content.trim() === "") continue;
      const node = await store.addNode({
        provenance: turn.role === "user" ? "UserInput" : "AIInferred",
        encryptionKeyRef: "longmemeval",
        memoryType: "Conversation",
        privacyClassification: "Private",
        retentionTier: "FullRetention",
        content: { text: turn.content },
        contextualMetadata: { tags: [sessionId], session: sessionId, turn: t, role: turn.role },
        confidenceWeight: 1,
        decayRate: 0,
        validFrom,
      });
      origin.set(node.nodeId, { session: s, turn: t });
    }
  }
  if (embedder) await lib.indexMissingEmbeddings(store, embedder);
  const retriever = new lib.HybridRetriever(store, embedder, reranker ? { reranker } : {});
  return { store, retriever, origin, memories: origin.size };
}

/**
 * The round a message belongs to, named by its user turn — the unit the
 * official reader is shown (run_generation.py expands a retrieved user turn to
 * that turn and the next). An assistant message belongs to the user turn before
 * it; one that opens a session, to the first user turn after it.
 */
function roundOf(session, turn) {
  for (let t = turn; t >= 0; t -= 1) if (session[t].role === "user") return t;
  for (let t = turn + 1; t < session.length; t += 1) if (session[t].role === "user") return t;
  return null;
}

/**
 * Ask the memory the question and turn what comes back into ranked rounds.
 * Each round carries its official corpus id (for the retrieval metrics), its
 * session date, and the turns the reader will see. With `expand`, recall reads
 * the question's time and counting cues, resolving "last week" against the
 * question's own date — the moment it is asked in the benchmark's story.
 */
export async function recallRounds(memory, instance, { freshness = 0, expand = false } = {}) {
  const hits = await memory.retriever.recall(instance.question, {
    limit: RECALL_POOL,
    ...(freshness > 0 ? { freshness } : {}),
    ...(expand ? { expand: { now: parseSessionDate(instance.question_date) } } : {}),
  });
  const { corpus } = corpusOf(instance);
  const idAt = new Map(corpus.map((c) => [`${c.session}:${c.turn}`, c.id]));
  const rounds = [];
  const seen = new Set();
  for (const node of hits) {
    const at = memory.origin.get(node.nodeId);
    if (!at) continue;
    const session = instance.haystack_sessions[at.session];
    const userTurn = roundOf(session, at.turn);
    if (userTurn === null) continue;
    const key = `${at.session}:${userTurn}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rounds.push({
      id: idAt.get(key),
      date: instance.haystack_dates[at.session],
      turns: session.slice(userTurn, userTurn + 2).map(({ role, content }) => ({ role, content })),
    });
  }
  return { rounds, memoriesRecalled: hits.length };
}

/**
 * The same embedder with a memo of every text it has embedded. LongMemEval
 * histories share most of their filler sessions, and each question gets a
 * fresh store, so without this a full run embeds the same message hundreds of
 * times. A vector is kept as float32 only when that is exact (it is for the
 * default on-device model), so a cached vector is always the one the model gave.
 */
export function cachingEmbedder(embedder) {
  const memo = new Map();
  const stats = { embedded: 0, reused: 0 };
  return {
    model: embedder.model,
    modelVersion: embedder.modelVersion,
    dimensions: embedder.dimensions,
    stats,
    async embed(texts) {
      const missing = [...new Set(texts.filter((t) => !memo.has(t)))];
      if (missing.length > 0) {
        const vectors = await embedder.embed(missing);
        missing.forEach((t, i) => {
          const v = vectors[i];
          const f = Float32Array.from(v);
          memo.set(t, f.every((x, j) => x === v[j]) ? f : [...v]);
        });
      }
      stats.embedded += missing.length;
      stats.reused += texts.length - missing.length;
      return texts.map((t) => Array.from(memo.get(t)));
    },
  };
}
