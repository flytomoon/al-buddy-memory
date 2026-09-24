/**
 * Sleep-time consolidation — a background pass that reads recent RAW memory and
 * proposes derived facts, without touching the raw.
 *
 * Some agent runtimes run "sleep-time" passes that review recent conversation and rewrite
 * memory blocks while the live agent idles. This is that idea under the
 * invalidate-never-delete rule: the raw nodes are never rewritten or dropped;
 * each derived fact is a NEW node, provenance "AIInferred", linked back to its
 * sources by Reinforcement edges, and each source gets a "summarized" anchor so
 * the pass never re-reads it. The model is injected — this library is
 * model-agnostic and calls nothing itself.
 */
import { isMentalModelNode } from "./mental-models.js";
import { compareBinary, compareRecency, learnedAt } from "./decay.js";
import { EVIDENCE, evidenceProblem, type EvidenceQuote } from "./evidence.js";
import { canonicalInstant, instantMs } from "./instant.js";
import { PRIVACY_CLASSIFICATIONS, RETENTION_TIERS } from "./types/memory.js";
import type { MemoryNode, MemoryStore, NewMemoryNode } from "./types/memory.js";

export interface RawExcerpt {
  nodeId: string;
  text: string;
  memoryType: MemoryNode["memoryType"];
  createdAt: string;
}

export interface DerivedFact {
  text: string;
  /** Which raw excerpts this fact rests on — at least one, or it is not written. */
  sourceNodeIds: string[];
  /**
   * The exact passage(s) of each source that support it — at least one per
   * source, each found in that source's text (whitespace-normalised), or the
   * fact is refused as unsupported (0.6.0; see evidence.ts).
   */
  evidence?: EvidenceQuote[];
  /** 0–1; default 0.7. A derived fact never claims more certainty than raw testimony. */
  confidence?: number;
  memoryType?: MemoryNode["memoryType"];
}

export interface ConsolidateOptions {
  /** Only raw nodes created at or after this instant are read. */
  since: string;
  /** The judgement: given recent raw excerpts, which durable facts follow. */
  propose: (raw: readonly RawExcerpt[]) => Promise<DerivedFact[]>;
  /** Named so the derived node records what produced it. */
  model: string;
  /** Read and propose, write nothing. */
  dryRun?: boolean;
  /** Cap on raw excerpts handed to the model in one pass. Default 200. */
  maxRaw?: number;
  now?: () => Date;
  encryptionKeyRef?: string;
  /**
   * Show the model Sensitive facts too. Off by default: Sensitive is "excluded
   * from summarization unless the user explicitly opts in" (types/memory.ts), so
   * only the person can switch this on. A fact derived from a Sensitive source is
   * written Sensitive. Sealed facts are never shown, whatever this says.
   */
  includeSensitive?: boolean;
}

export interface ConsolidationReport {
  read: number;
  proposed: number;
  written: number;
  /** Proposals refused, with why (no sources, empty text, unknown source id, unsupported by its evidence). */
  refused: { text: string; why: string }[];
  derivedNodeIds: string[];
}

const CONSOLIDATED_MARK = "consolidatedBy";

/** When the store learned it — the shared key, so a pass and a read agree. */
const createdAt = learnedAt;

/**
 * Oldest first: a consolidation pass reads the night in the order it happened.
 * The id settles a tie because the anchor is a millisecond stamp and a burst of
 * captures lands inside one — without it the order of two facts (and so which
 * one falls outside `maxRaw`) depends on how fast the machine was. This is
 * compareRecency read backwards, deliberately: the stores page newest first,
 * a pass replays oldest first, and both are total orders.
 */
function chronologically(a: MemoryNode, b: MemoryNode): number {
  return compareRecency(b, a);
}

function alreadyConsolidated(n: MemoryNode): boolean {
  return n.temporalAnchors.some((a) => a.event === "summarized") || n.contextualMetadata[CONSOLIDATED_MARK] !== undefined;
}

export async function consolidate(store: MemoryStore, opts: ConsolidateOptions): Promise<ConsolidationReport> {
  const now = (opts.now ?? (() => new Date()))().toISOString();
  // No limit. The read used to take the 5,000 highest-confidence facts and
  // THEN filter them by `since`, so a store holding more than that many older,
  // more confident facts handed the pass nothing recent at all — 5,100 old
  // facts at confidence 1 and ten recorded today: read 0. A pass that cannot
  // see today is not a pass (Astra R11/R16, 2026-09-18). The cost is a full
  // read per pass, which for a nightly background job over a personal store is
  // the right trade; `maxRaw` still bounds what the model is shown. Pushing
  // `since` into the query would make it O(new facts) and is the next step if
  // a pass ever gets expensive.
  //
  // Named classifications, never Sealed: every derived fact used to be written
  // Private whatever it rested on, so a Sensitive fact restated by the pass
  // reached every audience that may read Private (review 2026-09-22).
  const all = await store.searchNodes({ privacyClassification: opts.includeSensitive === true ? ["Public", "Private", "Sensitive"] : ["Public", "Private"] });
  // An instant, not a spelling: "+10:00" and "Z" sort differently as text.
  const sinceMs = instantMs(canonicalInstant(opts.since, "since"));
  const raw = all
    .filter((n) => n.provenance !== "AIInferred") // derived facts are never re-derived
    .filter((n) => !isMentalModelNode(n)) // a standing question is not something that happened
    .filter((n) => n.privacyClassification !== "Sealed")
    .filter((n) => instantMs(createdAt(n)) >= sinceMs)
    .filter((n) => !alreadyConsolidated(n))
    .sort(chronologically)
    .slice(0, opts.maxRaw ?? 200);
  const report: ConsolidationReport = { read: raw.length, proposed: 0, written: 0, refused: [], derivedNodeIds: [] };
  if (raw.length === 0) return report;

  const excerpts: RawExcerpt[] = raw.map((n) => ({ nodeId: n.nodeId, text: n.content.text, memoryType: n.memoryType, createdAt: createdAt(n) }));
  const proposals = await opts.propose(excerpts);
  report.proposed = proposals.length;
  const known = new Map(raw.map((n) => [n.nodeId, n]));

  for (const p of proposals) {
    const text = (p.text ?? "").trim();
    if (text === "") {
      report.refused.push({ text, why: "empty" });
      continue;
    }
    const sources = [...new Set(p.sourceNodeIds ?? [])];
    if (sources.length === 0) {
      report.refused.push({ text, why: "no source nodes — a derived fact must rest on raw" });
      continue;
    }
    const unknown = sources.filter((id) => !known.has(id));
    if (unknown.length > 0) {
      report.refused.push({ text, why: `source not in this pass: ${unknown.join(", ")}` });
      continue;
    }
    const evidence = (p.evidence ?? []).map((e) => ({ nodeId: e.nodeId, quote: String(e.quote ?? "").trim() }));
    const problem = evidenceProblem(sources, evidence, (id) => known.get(id)?.content.text);
    if (problem !== null) {
      report.refused.push({ text, why: `unsupported: ${problem}` });
      continue;
    }
    if (opts.dryRun) {
      report.written++;
      continue;
    }
    const node: NewMemoryNode = {
      provenance: "AIInferred",
      encryptionKeyRef: opts.encryptionKeyRef ?? "local",
      memoryType: p.memoryType ?? "Lesson",
      // As restricted as the most restricted fact it rests on, and never less than Private.
      privacyClassification: sources.some((id) => known.get(id)!.privacyClassification === "Sensitive") ? "Sensitive" : "Private",
      retentionTier: "FullRetention",
      content: { text },
      contextualMetadata: { derivedFrom: sources, [EVIDENCE]: evidence, [CONSOLIDATED_MARK]: opts.model, consolidatedAt: now, tags: ["derived"] },
      confidenceWeight: Math.max(0, Math.min(1, p.confidence ?? 0.7)),
      decayRate: 0,
    };
    // The fact and its evidence are separate writes and this interface has no
    // transaction to put them in, so a conclusion nobody can check must not be
    // able to stand: a source deleted while the model was thinking used to
    // leave the conclusion committed with no evidence edge and the pass thrown
    // out mid-flight (Astra R11, reproduced in both stores).
    //
    // It is written RETRACTED and stood up last. Retracting it afterwards was
    // the first attempt, and it does not compose with the audit latch: when the
    // audit sink is what failed, the store correctly refuses every further
    // change — including the compensating retraction — so the conclusion stayed
    // live on half its evidence and the pass threw (GPT-6-Astra on the merged
    // result, 2026-09-19). Bypassing the latch would undo the guarantee the
    // latch exists for. Inverting the order needs no compensation at all: the
    // only write that can make a derived fact current is the one that happens
    // after all of its evidence is recorded, so every way this can fail leaves
    // a withdrawn conclusion rather than an unsupported one.
    const pending: Retraction = { at: now, by: "consolidate", reason: "evidence not recorded yet" };
    let saved: MemoryNode | undefined;
    try {
      saved = await store.addNode({ ...node, validTo: now, contextualMetadata: { ...node.contextualMetadata, retraction: pending } });
      for (const src of sources) {
        await store.addEdge({ sourceNodeId: saved.nodeId, targetNodeId: src, relationshipType: "Reinforcement", strength: node.confidenceWeight, provenance: "AIInferred" });
      }
      saved = await store.updateNode(saved.nodeId, { validTo: null, contextualMetadata: node.contextualMetadata });
    } catch (err) {
      const why = `evidence could not be recorded: ${err instanceof Error ? err.message : String(err)}`;
      // Already retracted; all that is left is to say why, and even that is
      // allowed to fail — the reason is a courtesy, the retraction is the
      // guarantee.
      if (saved) await store.updateNode(saved.nodeId, { validTo: now, contextualMetadata: { ...node.contextualMetadata, retraction: { at: now, by: "consolidate", reason: why } } }).catch(() => undefined);
      report.refused.push({ text, why });
      continue;
    }
    report.written++;
    report.derivedNodeIds.push(saved.nodeId);
  }
  if (!opts.dryRun) {
    // Mark the raw as read by this pass — an anchor, never a rewrite. A fact
    // that has gone since the read is skipped rather than thrown over: it was
    // never consolidated, so nothing is owed to it.
    // The mark goes onto the fact as it is NOW: merging it onto the copy read
    // before the model ran erased whatever changed in between, such as an
    // invalidation's receipts (review 2026-09-22).
    for (const n of raw) {
      const fresh = await store.getNode(n.nodeId);
      if (!fresh) continue;
      await store.updateNode(n.nodeId, { contextualMetadata: { ...fresh.contextualMetadata, [CONSOLIDATED_MARK]: opts.model } }, "summarized");
    }
  }
  return report;
}

// ---------------------------------------------------------------------------
// Review and undo — "what did the agent conclude last night, and can I take it back?"
// ---------------------------------------------------------------------------

export interface ConsolidatedFact {
  nodeId: string;
  text: string;
  /** The raw nodes this fact rests on (the evidence). */
  derivedFrom: string[];
  confidence: number;
  /** Null while the fact stands; the instant it was retracted otherwise. */
  retractedAt: string | null;
  /** How it was withdrawn, when an undo withdrew it: by whom or what, and why. Null otherwise. */
  retraction: Retraction | null;
}

export interface Retraction {
  at: string;
  /** What withdrew it — "undoConsolidation" plus the caller's name for itself, e.g. "undoConsolidation (Chris via console)". */
  by: string;
  reason: string;
}

export interface ConsolidationRun {
  /** Identifies the pass: every fact it wrote carries this instant. */
  consolidatedAt: string;
  model: string;
  facts: ConsolidatedFact[];
}

function readRetraction(n: MemoryNode): Retraction | null {
  const r = n.contextualMetadata["retraction"] as Partial<Retraction> | undefined;
  return r && typeof r.at === "string" && typeof r.by === "string" && typeof r.reason === "string" ? { at: r.at, by: r.by, reason: r.reason } : null;
}

function isDerived(n: MemoryNode): boolean {
  return n.provenance === "AIInferred" && typeof n.contextualMetadata["consolidatedAt"] === "string";
}

/**
 * Review and undo read EVERY tier and classification the caller may see, not
 * the active-context defaults. `searchNodes({})` hides Archived,
 * PendingDeletion and Sealed facts, so archiving a derived fact made it
 * invisible to the review and untouchable by the undo: the undo reported
 * nothing retracted, left validTo null, and restoring the tier brought the
 * withdrawn conclusion back (Astra R11, 2026-09-18). Through a governed handle
 * the policies still decide what this actor sees — naming the tiers widens the
 * read, never the authority.
 */
const EVERY_TIER = { retentionTier: [...RETENTION_TIERS], privacyClassification: [...PRIVACY_CLASSIFICATIONS] };

/**
 * Every consolidation pass with the facts it wrote and their evidence, newest pass
 * first — retracted facts included, so the history stays readable.
 */
export async function listConsolidations(store: MemoryStore): Promise<ConsolidationRun[]> {
  const derived = (await store.searchNodes(EVERY_TIER)).filter(isDerived);
  const runs = new Map<string, ConsolidationRun>();
  for (const n of derived) {
    const at = n.contextualMetadata["consolidatedAt"] as string;
    const run = runs.get(at) ?? { consolidatedAt: at, model: String(n.contextualMetadata[CONSOLIDATED_MARK] ?? ""), facts: [] };
    run.facts.push({
      nodeId: n.nodeId,
      text: n.content.text,
      derivedFrom: (n.contextualMetadata["derivedFrom"] as string[] | undefined) ?? [],
      confidence: n.confidenceWeight,
      retractedAt: n.validTo,
      retraction: readRetraction(n),
    });
    runs.set(at, run);
  }
  // consolidatedAt IS the pass identity (it keys `runs`), so there is no tie to break here.
  return [...runs.values()].sort((a, b) => instantMs(b.consolidatedAt) - instantMs(a.consolidatedAt) || compareBinary(b.consolidatedAt, a.consolidatedAt));
}

export interface UndoConsolidationReport {
  /** Facts from that pass that were standing and are now retracted. */
  retracted: string[];
  /** Facts from that pass that had already been retracted or superseded. */
  alreadyRetracted: string[];
}

/**
 * Take back everything one consolidation pass concluded. Nothing is deleted: each
 * of its facts gets `validTo` = now, so recall stops using it, plus a `retraction`
 * record (when, by whom or what, and why), so the history shows it was believed,
 * that it was withdrawn by an undo, and the reason. The raw it read stays marked as
 * read, so tomorrow's pass does not simply derive the same conclusion again.
 */
export async function undoConsolidation(
  store: MemoryStore,
  consolidatedAt: string,
  opts: { now?: () => Date; reason: string; by?: string },
): Promise<UndoConsolidationReport> {
  const reason = (opts.reason ?? "").trim();
  if (reason === "") throw new Error("undoConsolidation needs a reason: an undo without one leaves the record unable to say why");
  const now = (opts.now ?? (() => new Date()))().toISOString();
  const report: UndoConsolidationReport = { retracted: [], alreadyRetracted: [] };
  const facts = (await store.searchNodes(EVERY_TIER)).filter((n) => isDerived(n) && n.contextualMetadata["consolidatedAt"] === consolidatedAt);
  for (const n of facts) {
    if (n.validTo !== null && n.validTo <= now) {
      report.alreadyRetracted.push(n.nodeId);
      continue;
    }
    const retraction: Retraction = { at: now, by: opts.by ? `undoConsolidation (${opts.by})` : "undoConsolidation", reason };
    await store.updateNode(n.nodeId, { validTo: now, contextualMetadata: { ...n.contextualMetadata, retraction } });
    report.retracted.push(n.nodeId);
  }
  return report;
}
