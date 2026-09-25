/**
 * Current state: "where does X stand now?" held as ONE live memory per subject.
 *
 * Most of what an assistant is asked about changes over time: a release, a
 * launch date, where a product is hosted, what version something runs on. As
 * ordinary facts, every status note stays true forever, so a question about the
 * release recalls every release note ever written, and wording decides which one
 * the assistant repeats. That is how an assistant came to report "0.5.1 is
 * staged, waiting for approval" two releases after 0.7.0 had gone live.
 *
 * A state memory names what it is the state OF — a subject ("al-buddy-memory")
 * and optionally an aspect ("latest release"). Recording a newer state of the
 * same subject and aspect closes the older one (`validTo`, `supersededBy`),
 * exactly as a refreshed mental-model answer closes the last one: nothing is
 * deleted, and "what did we think on the 22nd" is still a valid-time read.
 *
 *   - A state that arrives LATE (learned after a newer one was already recorded)
 *     never overturns the newer one; it is stored already closed, as history.
 *   - Saying the same state again changes nothing.
 *   - Only states are closed. An ordinary fact that happens to mention the
 *     subject is never touched — supersession is by declared key, not by guess.
 *
 * `statesMentionedIn` finds the live states a piece of text is about, so a host
 * can put "where things stand" in front of the model before anything older.
 * SPEC §8d.
 */
import { canonicalInstant } from "./instant.js";
import type { MemoryNode, MemoryNodeType, MemoryStore, PrivacyClassification, MemoryProvenance } from "./types/memory.js";

/** The metadata key a state memory carries its subject under. */
export const STATE = "stateOf";
/** Every state memory carries this tag, so states can be listed without a scan. */
export const STATE_TAG = "state";

export interface StateSubject {
  /** What this is the state of: a product, a project, a person, a plan. */
  subject: string;
  /** Which side of it, when a subject has several ("latest release", "hosting"). */
  aspect?: string;
}

export interface RecordStateInput extends StateSubject {
  /** The state, as a self-contained sentence. */
  text: string;
  /** Other names the subject goes by in conversation ("PTK"). */
  aliases?: string[];
  /** When this became the state. Default: now. */
  at?: string;
  provenance?: MemoryProvenance;
  memoryType?: MemoryNodeType;
  privacyClassification?: PrivacyClassification;
  confidenceWeight?: number;
  /** Extra tags; the state tag is always added. */
  tags?: string[];
  /** Extra metadata, kept alongside the state's own. */
  contextualMetadata?: Record<string, unknown>;
  encryptionKeyRef?: string;
}

export interface RecordStateResult {
  /** The state memory — the new one, or the existing one when nothing changed. */
  node: MemoryNode;
  /** The states this one closed. Empty when it arrived late or changed nothing. */
  superseded: MemoryNode[];
  /** True when the newest state already said this. */
  unchanged: boolean;
}

export interface StateRecord {
  nodeId: string;
  subject: string;
  aspect: string | null;
  aliases: string[];
  text: string;
  /** When it became the state. */
  since: string;
  /** When a newer state replaced it; null while it is current. */
  until: string | null;
  supersededBy: string | null;
}

interface StateMeta {
  subject: string;
  aspect?: string;
  aliases?: string[];
  key: string;
}

const squash = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
const words = (s: string): string[] => s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
const sameText = (a: string, b: string): boolean => a.trim().replace(/\s+/g, " ").toLowerCase() === b.trim().replace(/\s+/g, " ").toLowerCase();

/** The identity two states must share for one to replace the other: case, spacing and punctuation do not count. */
export function stateKey(s: StateSubject): string {
  return `${squash(s.subject)}|${squash(s.aspect ?? "")}`;
}

function stateMetaOf(node: MemoryNode): StateMeta | null {
  const m = node.contextualMetadata[STATE];
  if (typeof m !== "object" || m === null) return null;
  const meta = m as Partial<StateMeta>;
  return typeof meta.subject === "string" && typeof meta.key === "string" ? (meta as StateMeta) : null;
}

export function isStateNode(node: MemoryNode): boolean {
  return stateMetaOf(node) !== null;
}

function toRecord(node: MemoryNode, meta: StateMeta): StateRecord {
  const by = node.contextualMetadata["supersededBy"];
  return {
    nodeId: node.nodeId,
    subject: meta.subject,
    aspect: meta.aspect ?? null,
    aliases: meta.aliases ?? [],
    text: node.content.text,
    since: node.validFrom,
    until: node.validTo,
    supersededBy: typeof by === "string" ? by : null,
  };
}

async function statesWithKey(store: MemoryStore, key: string): Promise<MemoryNode[]> {
  const all = await store.searchNodes({ tags: [STATE_TAG], limit: Number.POSITIVE_INFINITY });
  return all.filter((n) => stateMetaOf(n)?.key === key);
}

const newestFirst = (a: MemoryNode, b: MemoryNode): number => (a.validFrom < b.validFrom ? 1 : a.validFrom > b.validFrom ? -1 : 0);

/**
 * Record the current state of a subject. A newer state closes the live one it
 * replaces; an older one arriving late is kept as history; a repeat is a no-op.
 */
export async function recordState(store: MemoryStore, input: RecordStateInput): Promise<RecordStateResult> {
  const subject = input.subject.trim();
  const text = input.text.trim();
  if (!subject) throw new Error("recordState: subject must not be empty");
  if (!text) throw new Error("recordState: text must not be empty");
  const aspect = input.aspect?.trim() || undefined;
  const when = canonicalInstant(input.at ?? new Date().toISOString(), "at");
  const key = stateKey({ subject, ...(aspect ? { aspect } : {}) });

  const live = (await statesWithKey(store, key)).filter((n) => n.validTo === null).sort(newestFirst);
  const newest = live[0];
  if (newest && sameText(newest.content.text, text)) return { node: newest, superseded: [], unchanged: true };

  // A newer state is already recorded: this one is history on arrival.
  const later = live.filter((n) => n.validFrom > when).sort((a, b) => -newestFirst(a, b))[0];
  const aliases = (input.aliases ?? []).map((a) => a.trim()).filter(Boolean);
  const meta: StateMeta = { subject, ...(aspect ? { aspect } : {}), ...(aliases.length ? { aliases } : {}), key };
  const node = await store.addNode({
    provenance: input.provenance ?? "AIInferred",
    encryptionKeyRef: input.encryptionKeyRef ?? "local",
    memoryType: input.memoryType ?? "Experience",
    privacyClassification: input.privacyClassification ?? "Private",
    retentionTier: "FullRetention",
    content: { text },
    contextualMetadata: {
      ...(input.contextualMetadata ?? {}),
      tags: [...new Set([STATE_TAG, ...(input.tags ?? [])])],
      [STATE]: meta,
      ...(later ? { supersededBy: later.nodeId } : {}),
    },
    confidenceWeight: input.confidenceWeight ?? 1,
    decayRate: 0,
    validFrom: when,
    ...(later ? { validTo: later.validFrom } : {}),
  });
  if (later) return { node, superseded: [], unchanged: false };

  const superseded: MemoryNode[] = [];
  for (const old of live) {
    if (old.validFrom > when) continue;
    superseded.push(await store.updateNode(old.nodeId, { validTo: when, contextualMetadata: { ...old.contextualMetadata, supersededBy: node.nodeId } }));
  }
  return { node, superseded, unchanged: false };
}

/** Every state that is current at `at` (default now), newest first. */
export async function currentStates(store: MemoryStore, opts: { at?: string } = {}): Promise<StateRecord[]> {
  const validAt = canonicalInstant(opts.at ?? new Date().toISOString(), "at");
  const nodes = await store.searchNodes({ tags: [STATE_TAG], validAt, limit: Number.POSITIVE_INFINITY });
  return nodes
    .sort(newestFirst)
    .flatMap((n) => {
      const meta = stateMetaOf(n);
      return meta ? [toRecord(n, meta)] : [];
    });
}

/** Every state a subject (and aspect) has had, newest first — the current one, then what it replaced. */
export async function stateHistory(store: MemoryStore, s: StateSubject): Promise<StateRecord[]> {
  return (await statesWithKey(store, stateKey(s))).sort(newestFirst).map((n) => toRecord(n, stateMetaOf(n)!));
}

/**
 * Does `text` name this subject? Whole words only, in order, with spacing and
 * punctuation free: "Al Buddy Memory", "al-buddy-memory" and "albuddymemory"
 * all name al-buddy-memory, and "the total" does not name "Al".
 */
function names(textWords: string[], name: string): boolean {
  const target = squash(name);
  if (!target) return false;
  for (let i = 0; i < textWords.length; i++) {
    let joined = "";
    for (let j = i; j < textWords.length && joined.length < target.length; j++) {
      joined += textWords[j];
      if (joined === target) return true;
    }
  }
  return false;
}

/** The states whose subject (or one of its aliases) `text` mentions, in the order given. */
export function statesMentionedIn(states: readonly StateRecord[], text: string): StateRecord[] {
  const w = words(text);
  return states.filter((s) => [s.subject, ...s.aliases].some((name) => names(w, name)));
}
