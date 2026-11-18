/**
 * One LoCoMo conversation into a fresh memory, and recall against it, through
 * the library's public API only (`SqliteMemoryStore`, `HybridRetriever`,
 * `indexMissingEmbeddings`). The library is passed in (`lib`), so the runner
 * uses the built package and the tests use the source.
 *
 * Every turn becomes one memory, as said: "<speaker>: <text>" (plus the
 * caption of a shared photo), `UserInput` — both speakers are people — a
 * `Conversation` valid from its session's date, tagged with its session and
 * dia_id. Nothing is extracted, summarised or rewritten. A conversation's
 * memory is built once and every one of its questions is asked of it.
 */
import { performance } from "node:perf_hooks";

import { turnText } from "./prompts.mjs";

/** How many memories one recall asks for: every candidate the keyword and vector lists supply (50 each), as in bench/longmemeval. */
export const RECALL_POOL = 100;

/**
 * A fresh store holding `conversation`. With an embedder, every memory is
 * embedded before any question is asked. `store` makes the empty store (the
 * tests pass an `InMemoryStore`).
 */
export async function ingestConversation(lib, conversation, { embedder, store: newStore = () => new lib.SqliteMemoryStore(":memory:") } = {}) {
  const store = newStore();
  /** nodeId → the turn it holds. */
  const turnOf = new Map();
  /** Every stored turn in conversation order, and each one's place in it, for `adjacentTurns`. */
  const order = [];
  const orderIndex = new Map();
  let memories = 0;
  try {
    for (const s of conversation.sessions) {
      for (const [position, turn] of s.turns.entries()) {
        const text = turnText(turn);
        if (turn.text.trim() === "" && !turn.caption) continue;
        const node = await store.addNode({
          provenance: "UserInput",
          encryptionKeyRef: "locomo",
          memoryType: "Conversation",
          privacyClassification: "Private",
          retentionTier: "FullRetention",
          content: { text },
          contextualMetadata: { tags: [`session_${s.session}`], session: s.session, diaId: turn.diaId, speaker: turn.speaker },
          confidenceWeight: 1,
          decayRate: 0,
          validFrom: s.date,
        });
        const stored = { ...turn, session: s.session, position, dateText: s.dateText };
        turnOf.set(node.nodeId, stored);
        orderIndex.set(turn.diaId, order.length);
        order.push(stored);
        memories += 1;
      }
    }
    if (embedder) await lib.indexMissingEmbeddings(store, embedder);
    const retriever = new lib.HybridRetriever(store, embedder);
    return { store, retriever, turnOf, order, orderIndex, memories };
  } catch (e) {
    store.close?.();
    throw e;
  }
}

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The text recall is asked, for `--strip-speakers`: the question without the
 * two speakers' names (whole, and first names; with any possessive "'s").
 * Every stored turn begins "<speaker>: ", so a speaker's name is in half the
 * memory: it says whose memory to search, as "I" does in a LongMemEval
 * question, not what to search for. Kept in, it pulls the short turns that
 * are little more than the name ("Caroline: Cool! What did it look like?")
 * to the top. A question with fewer than two words left is asked as written.
 */
export function recallQuery(question, speakers) {
  const names = [...new Set(speakers.flatMap((s) => [s.trim(), s.trim().split(/\s+/)[0]]).filter(Boolean))].sort((a, b) => b.length - a.length);
  let text = question;
  for (const name of names) text = text.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(name)}(?:['’]s)?(?![\\p{L}\\p{N}])`, "giu"), " ");
  text = text.replace(/\s+/g, " ").trim();
  return text.split(" ").length >= 2 ? text : question;
}

/** The stored turns just before and just after `turn` in its own session (either may be missing): next first, then previous. */
export function adjacentTurns(memory, turn) {
  const i = memory.orderIndex.get(turn.diaId);
  if (i === undefined) return [];
  return [memory.order[i + 1], memory.order[i - 1]].filter((t) => t && t.session === turn.session);
}

/**
 * What the reader is shown, at most `topK` turns. With `neighbours` = 0, the
 * first `topK` recalled. With `neighbours` = N (1..topK), the first N
 * recalled, then the turn after and the turn before each of them in its
 * session (best-ranked first), then the rest of what recall returned, until
 * `topK`. A LoCoMo answer is often the reply to the turn that matches the
 * question ("What did you research?" / "Adoption agencies"), so the turns
 * beside a hit are worth more than recall's 35th to 40th. `adjacent` maps a
 * recalled turn's dia_id to its neighbours (`adjacentTurns`).
 */
export function showTurns(ranked, { topK, neighbours = 0, adjacent = new Map() }) {
  if (!neighbours) return ranked.slice(0, topK);
  const shown = [];
  const seen = new Set();
  const add = (t) => {
    if (t && shown.length < topK && !seen.has(t.diaId)) {
      seen.add(t.diaId);
      shown.push(t);
    }
  };
  const head = ranked.slice(0, neighbours);
  for (const t of head) add(t);
  for (const t of head) for (const n of adjacent.get(t.diaId) ?? []) add(n);
  for (const t of ranked) add(t);
  return shown;
}

/**
 * Ask the memory one question; the turns it returns, best first. With
 * `expand`, recall reads the question's time and counting cues against
 * `conversation.now`, the date of the conversation's last session (LoCoMo's
 * questions are asked after the conversation and carry no date of their own).
 * With `stripSpeakers`, recall is asked `recallQuery` (the question without
 * the speakers' names); with `contentWords`, the library's
 * `RecallOptions.contentWords`. `query` is the text recall was asked.
 *
 * `recall` is how long the `recall` call alone took: `ms` by the wall clock,
 * `cpuMs` this process's CPU meanwhile, across its threads.
 */
export async function recallTurns(memory, conversation, question, { expand = false, recallPool = RECALL_POOL, stripSpeakers = false, contentWords = false } = {}) {
  const query = stripSpeakers ? recallQuery(question.question, conversation.speakers) : question.question;
  const cpu = process.cpuUsage();
  const t0 = performance.now();
  const hits = await memory.retriever.recall(query, {
    limit: recallPool,
    ...(recallPool !== RECALL_POOL ? { candidates: Math.max(1, Math.ceil(recallPool / 2)) } : {}),
    ...(expand ? { expand: { now: conversation.now } } : {}),
    ...(contentWords ? { contentWords: true } : {}),
  });
  const ms = performance.now() - t0;
  const { user, system } = process.cpuUsage(cpu);
  const turns = [];
  const seen = new Set();
  for (const node of hits) {
    const turn = memory.turnOf.get(node.nodeId);
    if (!turn) throw new Error(`recall returned ${node.nodeId}, which is not a turn of ${conversation.sampleId}`);
    if (seen.has(turn.diaId)) continue;
    seen.add(turn.diaId);
    turns.push(turn);
  }
  return { turns, query, memoriesRecalled: hits.length, recall: { ms: Math.round(ms * 10) / 10, cpuMs: Math.round((user + system) / 100) / 10 } };
}
