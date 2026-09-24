/**
 * Mental models: a standing question with a pre-written answer, kept current in
 * the background, so reading it costs no model call.
 *
 * "What does Chris care about when choosing tools?", "Where is the launch right
 * now?" — asked often, answered from many facts, and expensive to recompute on
 * every read. A mental model holds the answer ready, and says how fresh it is.
 *
 * The design keeps every guarantee the rest of the library makes:
 *
 *   - A model is two kinds of node. The DEFINITION holds the question and the
 *     scope of facts that feed it. Each refresh writes a NEW ANSWER node: an
 *     AIInferred conclusion that names the facts it rests on (`derivedFrom`) and
 *     quotes them (`evidence`, checked verbatim), exactly like a consolidation
 *     conclusion. The previous answer is closed (`validTo`, `supersededBy`), never
 *     overwritten — so "what did we think in June" is a valid-time read.
 *   - Because an answer is an ordinary conclusion, the two paths a source can
 *     take apply to it unchanged (SPEC §8a): a fact that STOPS BEING TRUE retracts
 *     the answer resting on it (kept, marked); a fact that MUST NOT EXIST erases
 *     the answer with it, so erased words cannot survive in a summary. The
 *     definition — the question — is never touched by either; the model reads as
 *     STALE and is refreshed on the next pass.
 *   - An answer is as restricted as the most restricted fact it rests on, never
 *     less than Private. Sealed facts are never shown to the model; Sensitive
 *     ones only when the host opts in, as for consolidation.
 *   - Reads are plain store reads, so a governed handle's read policies decide
 *     what a reader sees: an answer the reader may not read is withheld; a source
 *     it may not read is named as withheld and its quote is not shown.
 *
 * Refresh is host-driven: `refreshMentalModels` with an injected `propose`, run
 * on a schedule (nightly, beside consolidation) or on demand.
 */
import { learnedAt } from "./decay.js";
import { EVIDENCE, evidenceOf, evidenceProblem, quoteHolds, type EvidenceQuote } from "./evidence.js";
import { MEMORY_NODE_TYPES, PRIVACY_CLASSIFICATIONS, RETENTION_TIERS } from "./types/memory.js";
import type { MemoryNode, MemoryNodeType, MemoryStore, NewMemoryNode, PrivacyClassification } from "./types/memory.js";

/** The metadata key a definition carries its question and scope under. */
export const MENTAL_MODEL = "mentalModel";
/** The metadata key an answer names its definition under. */
export const MODEL_ANSWER = "mentalModelAnswer";
export const MENTAL_MODEL_TAG = "mental-model";
/** What an answer was shown: the newest fact's learned-at and the ids, for the freshness check. */
const SHOWN = "shownFacts";
const UNAVAILABLE = "its newest answer is not available here — erased along with a fact it rested on, or withheld from this reader";

export const QUESTION_MAX_CHARS = 500;
export const ANSWER_MAX_CHARS = 4000;

/** Which facts feed a model. Omitted fields do not narrow. */
export interface MentalModelScope {
  /** A fact must carry at least one of these tags. */
  tags?: string[];
  memoryType?: MemoryNodeType[];
}

interface DefinitionMeta {
  question: string;
  scope: MentalModelScope;
  /** The newest answer this model has had, so an erased answer is noticed. */
  lastAnswerId?: string;
  lastAnswerAt?: string;
}

export interface ModelFact {
  nodeId: string;
  text: string;
  memoryType: MemoryNodeType;
  learnedAt: string;
}

/** One model the refresh asks about: the question and the facts in its scope. */
export interface ModelRequest {
  modelId: string;
  question: string;
  facts: ModelFact[];
}

/** The judgement's answer for one model: the text and the exact words it rests on. */
export interface ModelProposal {
  modelId: string;
  answer: string;
  evidence: EvidenceQuote[];
}

export interface Staleness {
  since: string;
  because: string;
}

export interface MentalModelEvidence {
  nodeId: string;
  quote: string | null;
  source: "available" | "withheld";
  holds: boolean | null;
}

export interface MentalModel {
  id: string;
  question: string;
  scope: MentalModelScope;
  definedAt: string;
  /** Null until the first refresh, or when the reader may not read the answer. */
  answer: string | null;
  answerId: string | null;
  answeredAt: string | null;
  /** The answer's privacy class, as restricted as its most restricted source. */
  privacyClassification: PrivacyClassification | null;
  evidence: MentalModelEvidence[];
  fresh: boolean;
  stale: Staleness | null;
  /**
   * True when the model has been answered but its newest answer cannot be read
   * here: withheld from this reader by policy, or erased along with a fact it
   * rested on (a governed read cannot tell the two apart, so neither is claimed).
   */
  withheld: boolean;
}

export interface AnswerVersion {
  answerId: string;
  answer: string;
  from: string;
  to: string | null;
  /** Why it stopped: replaced by a newer answer, or retracted (and why). */
  ended: null | { by: "refresh"; supersededBy: string } | { by: string; reason: string };
}

export interface RefreshOptions {
  propose: (requests: readonly ModelRequest[]) => Promise<ModelProposal[]>;
  now?: () => Date;
  /** Refresh only models with no answer or a stale one. Default true. */
  onlyStale?: boolean;
  /** Models asked about in one call. Default 20. */
  maxModels?: number;
  /** Newest facts handed to the model per question. Default 60. */
  maxFactsPerModel?: number;
  /** Show Sensitive facts too (never Sealed). Off by default, as for consolidation. */
  includeSensitive?: boolean;
  encryptionKeyRef?: string;
}

export interface RefreshReport {
  asked: number;
  written: { modelId: string; answerId: string }[];
  /** Proposals refused, with why; the previous answer stays. */
  refused: { modelId: string; why: string }[];
  /** Stale models with no facts in scope: nothing to answer from. */
  empty: string[];
}

const EVERY_TIER = { retentionTier: [...RETENTION_TIERS], privacyClassification: [...PRIVACY_CLASSIFICATIONS] };
const RANK: Record<PrivacyClassification, number> = { Public: 0, Private: 1, Sensitive: 2, Sealed: 3 };

const definitionOf = (n: MemoryNode): DefinitionMeta | null => {
  const raw = n.contextualMetadata[MENTAL_MODEL] as Partial<DefinitionMeta> | undefined;
  if (!raw || typeof raw.question !== "string") return null;
  return { question: raw.question, scope: (raw.scope ?? {}) as MentalModelScope, ...(raw.lastAnswerId ? { lastAnswerId: raw.lastAnswerId } : {}), ...(raw.lastAnswerAt ? { lastAnswerAt: raw.lastAnswerAt } : {}) };
};
const answerOf = (n: MemoryNode): string | null => {
  const v = n.contextualMetadata[MODEL_ANSWER];
  return typeof v === "string" ? v : null;
};
/** Mental-model nodes (definitions and answers) are never facts a model is built from. */
export function isMentalModelNode(n: Pick<MemoryNode, "contextualMetadata">): boolean {
  return n.contextualMetadata[MENTAL_MODEL] !== undefined || n.contextualMetadata[MODEL_ANSWER] !== undefined;
}
const tagsOf = (n: MemoryNode): string[] => {
  const t = n.contextualMetadata["tags"];
  return Array.isArray(t) ? t.filter((x): x is string => typeof x === "string") : [];
};
const inScope = (n: MemoryNode, scope: MentalModelScope): boolean =>
  (!scope.tags || scope.tags.length === 0 || tagsOf(n).some((t) => scope.tags!.includes(t))) &&
  (!scope.memoryType || scope.memoryType.length === 0 || scope.memoryType.includes(n.memoryType));
const liveAt = (n: MemoryNode, at: number): boolean => Date.parse(n.validFrom) <= at && (n.validTo === null || Date.parse(n.validTo) > at);

function cleanScope(scope: MentalModelScope | undefined): MentalModelScope {
  const out: MentalModelScope = {};
  const tags = (scope?.tags ?? []).filter((t) => typeof t === "string" && t.trim() !== "").map((t) => t.trim());
  if (tags.length > 0) out.tags = [...new Set(tags)];
  const types = (scope?.memoryType ?? []).filter((t): t is MemoryNodeType => (MEMORY_NODE_TYPES as readonly string[]).includes(t));
  if (types.length > 0) out.memoryType = [...new Set(types)];
  return out;
}

/** Define a standing question. Returns the model's id (the definition node's id). */
export async function defineMentalModel(
  store: MemoryStore,
  input: { question: string; scope?: MentalModelScope; encryptionKeyRef?: string },
): Promise<string> {
  const question = input.question.replace(/\s+/g, " ").trim();
  if (question === "") throw new Error("A mental model needs a question.");
  if (question.length > QUESTION_MAX_CHARS) throw new Error(`A mental model's question is at most ${QUESTION_MAX_CHARS} characters.`);
  const node: NewMemoryNode = {
    provenance: "SystemGenerated",
    encryptionKeyRef: input.encryptionKeyRef ?? "local",
    memoryType: "Belief",
    privacyClassification: "Private",
    retentionTier: "FullRetention",
    content: { text: question },
    contextualMetadata: { [MENTAL_MODEL]: { question, scope: cleanScope(input.scope) }, tags: [MENTAL_MODEL_TAG] },
    confidenceWeight: 0.5,
    decayRate: 0,
  };
  return (await store.addNode(node)).nodeId;
}

async function everything(store: MemoryStore): Promise<MemoryNode[]> {
  return store.searchNodes(EVERY_TIER);
}

function answersFor(nodes: readonly MemoryNode[], modelId: string): MemoryNode[] {
  // By the refresh that wrote each one (its validFrom), then when the store learned it:
  // two refreshes inside one millisecond still read in the order they ran.
  return nodes
    .filter((n) => answerOf(n) === modelId)
    .sort((a, b) => Date.parse(a.validFrom) - Date.parse(b.validFrom) || Date.parse(learnedAt(a)) - Date.parse(learnedAt(b)) || a.nodeId.localeCompare(b.nodeId));
}

/** The facts a model is built from, newest first: live, in scope, never a model node, never Sealed. */
function factsFor(nodes: readonly MemoryNode[], scope: MentalModelScope, at: number, includeSensitive: boolean): MemoryNode[] {
  return nodes
    .filter((n) => !isMentalModelNode(n) && liveAt(n, at) && n.retentionTier !== "PendingDeletion" && n.retentionTier !== "Archived")
    .filter((n) => n.privacyClassification !== "Sealed" && (includeSensitive || n.privacyClassification !== "Sensitive"))
    .filter((n) => inScope(n, scope))
    .sort((a, b) => Date.parse(learnedAt(b)) - Date.parse(learnedAt(a)) || a.nodeId.localeCompare(b.nodeId));
}

/** How fresh a model is, from what the store already holds — no model call. */
function staleness(def: MemoryNode, meta: DefinitionMeta, latest: MemoryNode | undefined, nodes: readonly MemoryNode[], at: number): Staleness | null {
  // Through a governed handle an erased answer and a withheld one both read as
  // absent, so neither is claimed: the message names both.
  if (!latest) {
    if (meta.lastAnswerId) return { since: meta.lastAnswerAt ?? def.validFrom, because: UNAVAILABLE };
    return { since: def.validFrom, because: "not answered yet" };
  }
  if (meta.lastAnswerId && latest.nodeId !== meta.lastAnswerId) {
    return { since: meta.lastAnswerAt ?? learnedAt(latest), because: `${UNAVAILABLE}; this is the one before it` };
  }
  if (latest.validTo !== null && Date.parse(latest.validTo) <= at) {
    const r = latest.contextualMetadata["retraction"] as { reason?: string } | undefined;
    return { since: latest.validTo, because: r?.reason ?? "its answer was withdrawn" };
  }
  // Newer than the newest fact the answer was shown — by the store's own record
  // of when it learned each fact, with the ids settling a same-millisecond tie,
  // so the check never depends on how fast the machine was.
  const shown = latest.contextualMetadata[SHOWN] as { newestAt?: string; ids?: string[] } | undefined;
  const newestMs = shown?.newestAt ? Date.parse(shown.newestAt) : Date.parse(learnedAt(latest));
  const shownIds = new Set(Array.isArray(shown?.ids) ? shown!.ids : []);
  const newer = factsFor(nodes, meta.scope, at, true).filter((n) => {
    const ms = Date.parse(learnedAt(n));
    return ms > newestMs || (ms === newestMs && !shownIds.has(n.nodeId));
  });
  if (newer.length > 0) {
    return { since: learnedAt(newer[newer.length - 1]!), because: `${newer.length} newer fact${newer.length === 1 ? "" : "s"} in scope since the last answer` };
  }
  return null;
}

async function readModel(store: MemoryStore, def: MemoryNode, nodes: readonly MemoryNode[], at: number): Promise<MentalModel | null> {
  const meta = definitionOf(def);
  if (!meta) return null;
  const answers = answersFor(nodes, def.nodeId);
  const latest = answers[answers.length - 1];
  const stale = staleness(def, meta, latest, nodes, at);
  const base = { id: def.nodeId, question: meta.question, scope: meta.scope, definedAt: def.validFrom, fresh: stale === null, stale };
  if (!latest) return { ...base, answer: null, answerId: null, answeredAt: null, privacyClassification: null, evidence: [], withheld: meta.lastAnswerId !== undefined };
  // The answer is read through the store, so a governed handle's read policy decides.
  const visible = await store.getNode(latest.nodeId);
  if (!visible) return { ...base, answer: null, answerId: null, answeredAt: null, privacyClassification: null, evidence: [], withheld: true };
  const evidence: MentalModelEvidence[] = [];
  for (const e of evidenceOf(visible)) {
    const source = await store.getNode(e.nodeId);
    evidence.push(source ? { nodeId: e.nodeId, quote: e.quote, source: "available", holds: quoteHolds(e.quote, source.content.text) } : { nodeId: e.nodeId, quote: null, source: "withheld", holds: null });
  }
  return { ...base, answer: visible.content.text, answerId: visible.nodeId, answeredAt: learnedAt(visible), privacyClassification: visible.privacyClassification, evidence, withheld: false };
}

/** One model, with its answer, freshness and evidence. Null when it is not a model or this reader may not read it. */
export async function getMentalModel(store: MemoryStore, id: string, opts: { now?: () => Date } = {}): Promise<MentalModel | null> {
  const def = await store.getNode(id);
  if (!def || !definitionOf(def)) return null;
  const at = (opts.now ?? (() => new Date()))().getTime();
  return readModel(store, def, await everything(store), at);
}

/** Every model this reader may read, oldest definition first. */
export async function listMentalModels(store: MemoryStore, opts: { now?: () => Date } = {}): Promise<MentalModel[]> {
  const at = (opts.now ?? (() => new Date()))().getTime();
  const nodes = await everything(store);
  const out: MentalModel[] = [];
  for (const def of nodes.filter((n) => definitionOf(n) !== null).sort((a, b) => Date.parse(a.validFrom) - Date.parse(b.validFrom))) {
    const m = await readModel(store, def, nodes, at);
    if (m) out.push(m);
  }
  return out;
}

/** Every answer the model has had, oldest first — what we thought, and until when. */
export async function mentalModelHistory(store: MemoryStore, id: string): Promise<AnswerVersion[]> {
  const nodes = await everything(store);
  return answersFor(nodes, id).map((n) => {
    const superseded = n.contextualMetadata["supersededBy"];
    const retraction = n.contextualMetadata["retraction"] as { by?: string; reason?: string } | undefined;
    const ended: AnswerVersion["ended"] =
      n.validTo === null ? null : typeof superseded === "string" ? { by: "refresh", supersededBy: superseded } : { by: retraction?.by ?? "unknown", reason: retraction?.reason ?? "withdrawn" };
    return { answerId: n.nodeId, answer: n.content.text, from: n.validFrom, to: n.validTo, ended };
  });
}

/** The answer the model gave as of `at` (valid time), or null. */
export async function mentalModelAsOf(store: MemoryStore, id: string, at: string): Promise<AnswerVersion | null> {
  const ms = Date.parse(at);
  return (await mentalModelHistory(store, id)).find((v) => Date.parse(v.from) <= ms && (v.to === null || Date.parse(v.to) > ms)) ?? null;
}

/**
 * Ask the judgement about every stale model at once and write the answers that
 * its evidence supports. A refused answer leaves the previous one in place.
 */
export async function refreshMentalModels(store: MemoryStore, opts: RefreshOptions): Promise<RefreshReport> {
  const nowDate = (opts.now ?? (() => new Date()))();
  const now = nowDate.toISOString();
  const at = nowDate.getTime();
  const nodes = await everything(store);
  const report: RefreshReport = { asked: 0, written: [], refused: [], empty: [] };
  const requests: ModelRequest[] = [];
  const factsById = new Map<string, Map<string, MemoryNode>>();
  const latestById = new Map<string, MemoryNode | undefined>();
  for (const def of nodes) {
    const meta = definitionOf(def);
    if (!meta || def.validTo !== null) continue;
    const answers = answersFor(nodes, def.nodeId);
    const latest = answers[answers.length - 1];
    if (opts.onlyStale !== false && staleness(def, meta, latest, nodes, at) === null) continue;
    const facts = factsFor(nodes, meta.scope, at, opts.includeSensitive === true).slice(0, opts.maxFactsPerModel ?? 60);
    if (facts.length === 0) {
      report.empty.push(def.nodeId);
      continue;
    }
    factsById.set(def.nodeId, new Map(facts.map((f) => [f.nodeId, f])));
    latestById.set(def.nodeId, latest && latest.validTo === null ? latest : undefined);
    requests.push({ modelId: def.nodeId, question: meta.question, facts: facts.map((f) => ({ nodeId: f.nodeId, text: f.content.text, memoryType: f.memoryType, learnedAt: learnedAt(f) })) });
    if (requests.length >= (opts.maxModels ?? 20)) break;
  }
  report.asked = requests.length;
  if (requests.length === 0) return report;

  const proposals = await opts.propose(requests);
  const answered = new Set<string>();
  for (const p of proposals) {
    const facts = factsById.get(p.modelId);
    if (!facts || answered.has(p.modelId)) continue;
    answered.add(p.modelId);
    const answer = String(p.answer ?? "").trim();
    if (answer === "") {
      report.refused.push({ modelId: p.modelId, why: "empty answer" });
      continue;
    }
    if (answer.length > ANSWER_MAX_CHARS) {
      report.refused.push({ modelId: p.modelId, why: `answer longer than ${ANSWER_MAX_CHARS} characters` });
      continue;
    }
    const evidence = (p.evidence ?? []).map((e) => ({ nodeId: String(e.nodeId), quote: String(e.quote ?? "").trim() }));
    const sources = [...new Set(evidence.map((e) => e.nodeId))];
    if (sources.length === 0) {
      report.refused.push({ modelId: p.modelId, why: "unsupported: no evidence — an answer must quote the facts it rests on" });
      continue;
    }
    const unknown = sources.filter((id) => !facts.has(id));
    if (unknown.length > 0) {
      report.refused.push({ modelId: p.modelId, why: `unsupported: quotes a fact not in its scope: ${unknown.join(", ")}` });
      continue;
    }
    const problem = evidenceProblem(sources, evidence, (id) => facts.get(id)?.content.text);
    if (problem !== null) {
      report.refused.push({ modelId: p.modelId, why: `unsupported: ${problem}` });
      continue;
    }
    const worst = sources.map((id) => facts.get(id)!.privacyClassification).reduce((a, b) => (RANK[b] > RANK[a] ? b : a), "Private" as PrivacyClassification);
    const saved = await store.addNode({
      provenance: "AIInferred",
      encryptionKeyRef: opts.encryptionKeyRef ?? "local",
      memoryType: "Belief",
      privacyClassification: worst,
      retentionTier: "FullRetention",
      content: { text: answer },
      contextualMetadata: {
        [MODEL_ANSWER]: p.modelId,
        derivedFrom: sources,
        [EVIDENCE]: evidence,
        refreshedAt: now,
        [SHOWN]: { newestAt: learnedAt([...facts.values()][0]!), ids: [...facts.keys()] },
        tags: [MENTAL_MODEL_TAG],
      },
      confidenceWeight: 0.7,
      decayRate: 0,
      validFrom: now,
    });
    const previous = latestById.get(p.modelId);
    if (previous) {
      const current = await store.getNode(previous.nodeId);
      if (current && current.validTo === null) {
        await store.updateNode(previous.nodeId, { validTo: now, contextualMetadata: { ...current.contextualMetadata, supersededBy: saved.nodeId } });
      }
    }
    const def = await store.getNode(p.modelId);
    if (def) {
      const meta = definitionOf(def)!;
      await store.updateNode(p.modelId, { contextualMetadata: { ...def.contextualMetadata, [MENTAL_MODEL]: { ...meta, lastAnswerId: saved.nodeId, lastAnswerAt: now } } });
    }
    report.written.push({ modelId: p.modelId, answerId: saved.nodeId });
  }
  for (const r of requests) {
    if (!answered.has(r.modelId)) report.refused.push({ modelId: r.modelId, why: "no answer proposed" });
  }
  return report;
}

/** Remove a model: its answers, then its definition. Through a governed handle, erasure policy decides. */
export async function deleteMentalModel(store: MemoryStore, id: string): Promise<{ erased: number }> {
  const def = await store.getNode(id);
  if (!def || !definitionOf(def)) throw new Error(`There is no mental model ${id}.`);
  const answers = answersFor(await everything(store), id);
  for (const a of answers) if (await store.getNode(a.nodeId)) await store.deleteNode(a.nodeId);
  await store.deleteNode(id);
  return { erased: answers.length + 1 };
}
