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
import { learnedAt } from "./decay.js";
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
}

export interface ConsolidationReport {
  read: number;
  proposed: number;
  written: number;
  /** Proposals refused, with why (no sources, empty text, unknown source id). */
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
  return createdAt(a).localeCompare(createdAt(b)) || a.nodeId.localeCompare(b.nodeId);
}

function alreadyConsolidated(n: MemoryNode): boolean {
  return n.temporalAnchors.some((a) => a.event === "summarized") || n.contextualMetadata[CONSOLIDATED_MARK] !== undefined;
}

export async function consolidate(store: MemoryStore, opts: ConsolidateOptions): Promise<ConsolidationReport> {
  const now = (opts.now ?? (() => new Date()))().toISOString();
  const all = await store.searchNodes({ limit: 5_000 });
  const raw = all
    .filter((n) => n.provenance !== "AIInferred") // derived facts are never re-derived
    .filter((n) => createdAt(n) >= opts.since)
    .filter((n) => !alreadyConsolidated(n))
    .sort(chronologically)
    .slice(0, opts.maxRaw ?? 200);
  const report: ConsolidationReport = { read: raw.length, proposed: 0, written: 0, refused: [], derivedNodeIds: [] };
  if (raw.length === 0) return report;

  const excerpts: RawExcerpt[] = raw.map((n) => ({ nodeId: n.nodeId, text: n.content.text, memoryType: n.memoryType, createdAt: createdAt(n) }));
  const proposals = await opts.propose(excerpts);
  report.proposed = proposals.length;
  const known = new Set(raw.map((n) => n.nodeId));

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
    if (opts.dryRun) {
      report.written++;
      continue;
    }
    const node: NewMemoryNode = {
      provenance: "AIInferred",
      encryptionKeyRef: opts.encryptionKeyRef ?? "local",
      memoryType: p.memoryType ?? "Lesson",
      privacyClassification: "Private",
      retentionTier: "FullRetention",
      content: { text },
      contextualMetadata: { derivedFrom: sources, [CONSOLIDATED_MARK]: opts.model, consolidatedAt: now, tags: ["derived"] },
      confidenceWeight: Math.max(0, Math.min(1, p.confidence ?? 0.7)),
      decayRate: 0,
    };
    const saved = await store.addNode(node);
    for (const src of sources) {
      await store.addEdge({ sourceNodeId: saved.nodeId, targetNodeId: src, relationshipType: "Reinforcement", strength: node.confidenceWeight, provenance: "AIInferred" });
    }
    report.written++;
    report.derivedNodeIds.push(saved.nodeId);
  }
  if (!opts.dryRun) {
    // Mark the raw as read by this pass — an anchor, never a rewrite.
    for (const n of raw) await store.updateNode(n.nodeId, { contextualMetadata: { ...n.contextualMetadata, [CONSOLIDATED_MARK]: opts.model } }, "summarized");
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
 * Every consolidation pass with the facts it wrote and their evidence, newest pass
 * first — retracted facts included, so the history stays readable.
 */
export async function listConsolidations(store: MemoryStore): Promise<ConsolidationRun[]> {
  const derived = (await store.searchNodes({})).filter(isDerived);
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
  return [...runs.values()].sort((a, b) => b.consolidatedAt.localeCompare(a.consolidatedAt));
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
  const facts = (await store.searchNodes({})).filter((n) => isDerived(n) && n.contextualMetadata["consolidatedAt"] === consolidatedAt);
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
