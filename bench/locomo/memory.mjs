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
        turnOf.set(node.nodeId, { ...turn, session: s.session, position, dateText: s.dateText });
        memories += 1;
      }
    }
    if (embedder) await lib.indexMissingEmbeddings(store, embedder);
    const retriever = new lib.HybridRetriever(store, embedder);
    return { store, retriever, turnOf, memories };
  } catch (e) {
    store.close?.();
    throw e;
  }
}

/**
 * Ask the memory one question; the turns it returns, best first. With
 * `expand`, recall reads the question's time and counting cues against
 * `conversation.now`, the date of the conversation's last session (LoCoMo's
 * questions are asked after the conversation and carry no date of their own).
 *
 * `recall` is how long the `recall` call alone took: `ms` by the wall clock,
 * `cpuMs` this process's CPU meanwhile, across its threads.
 */
export async function recallTurns(memory, conversation, question, { expand = false, recallPool = RECALL_POOL } = {}) {
  const cpu = process.cpuUsage();
  const t0 = performance.now();
  const hits = await memory.retriever.recall(question.question, {
    limit: recallPool,
    ...(recallPool !== RECALL_POOL ? { candidates: Math.max(1, Math.ceil(recallPool / 2)) } : {}),
    ...(expand ? { expand: { now: conversation.now } } : {}),
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
  return { turns, memoriesRecalled: hits.length, recall: { ms: Math.round(ms * 10) / 10, cpuMs: Math.round((user + system) / 100) / 10 } };
}
