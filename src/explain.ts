/**
 * "Why do you believe that?" in one call.
 *
 * `explainFact(store, id)` answers with the fact, who asserted it and through
 * which assistant, when it was true and what ended or replaced it, and — for a
 * conclusion — the exact words it rests on, each checked against its source
 * now. Through a governed handle every read in here is the handle's: the fact
 * is explained only if this reader may read it, and a source this reader may
 * not read is named as withheld, its quote not shown (the quote is that
 * source's own words).
 *
 * Added in our 2026-09-22 review: provenance, validity, evidence and history
 * each had a reader, and no single call put them side by side.
 */
import { derivedFromOf } from "./derived.js";
import { evidenceOf, quoteHolds } from "./evidence.js";
import { isHistoryCapable } from "./history.js";
import { learnedAt } from "./decay.js";
import { readOrigin, type Origin } from "./provenance.js";
import type { MemoryNode, MemoryStore } from "./types/memory.js";

export interface EvidenceCheck {
  nodeId: string;
  /** The quoted words; null when the source is withheld from this reader. */
  quote: string | null;
  /** "withheld": this reader may not read the source, or it is no longer held. */
  source: "available" | "withheld";
  /** Whether the quote is in the source's text now; null when that cannot be checked. */
  holds: boolean | null;
}

export interface Explanation {
  fact: {
    id: string;
    text: string;
    provenance: MemoryNode["provenance"];
    /** Which assistant or client wrote it, when the host recorded one. */
    origin: Origin | null;
    memoryType: MemoryNode["memoryType"];
    privacyClassification: MemoryNode["privacyClassification"];
    confidence: number;
    learnedAt: string;
  };
  validity: {
    validFrom: string;
    validTo: string | null;
    /** In force now. */
    current: boolean;
    supersededBy: string | null;
    /** Why it was retired, when the retirement said. */
    reason: string | null;
    /** How a conclusion was withdrawn: by an undo, by its source ending, by a failed check. */
    retraction: { at: string; by: string; reason: string } | null;
  };
  /** For a conclusion: what it rests on and the words that support it. Null for a stated fact. */
  derived: null | {
    derivedFrom: string[];
    model: string | null;
    consolidatedAt: string | null;
    evidence: EvidenceCheck[];
  };
  /** Recorded changes, when the store keeps history. */
  history: null | { versions: number; first: string | null; last: string | null };
}

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

export async function explainFact(store: MemoryStore, id: string, opts: { now?: () => Date } = {}): Promise<Explanation | undefined> {
  const node = await store.getNode(id);
  if (!node) return undefined;
  const now = (opts.now ?? (() => new Date()))().getTime();
  const about = node.contextualMetadata;

  const r = about["retraction"] as { at?: unknown; by?: unknown; reason?: unknown } | undefined;
  const retraction = r && typeof r.at === "string" && typeof r.by === "string" && typeof r.reason === "string" ? { at: r.at, by: r.by, reason: r.reason } : null;

  let derived: Explanation["derived"] = null;
  const sources = derivedFromOf(node);
  if (sources.length > 0) {
    const evidence: EvidenceCheck[] = [];
    const quotes = evidenceOf(node);
    for (const sourceId of sources) {
      const source = await store.getNode(sourceId);
      const mine = quotes.filter((q) => q.nodeId === sourceId);
      if (!source) {
        evidence.push({ nodeId: sourceId, quote: null, source: "withheld", holds: null });
        continue;
      }
      if (mine.length === 0) evidence.push({ nodeId: sourceId, quote: null, source: "available", holds: null });
      for (const q of mine) evidence.push({ nodeId: sourceId, quote: q.quote, source: "available", holds: quoteHolds(q.quote, source.content.text) });
    }
    derived = { derivedFrom: sources, model: str(about["consolidatedBy"]), consolidatedAt: str(about["consolidatedAt"]), evidence };
  }

  let history: Explanation["history"] = null;
  if (isHistoryCapable(store)) {
    const versions = await store.history(id);
    history = { versions: versions.length, first: versions[0]?.recordedAt ?? null, last: versions.at(-1)?.recordedAt ?? null };
  }

  return {
    fact: {
      id: node.nodeId,
      text: node.content.text,
      provenance: node.provenance,
      origin: readOrigin(about),
      memoryType: node.memoryType,
      privacyClassification: node.privacyClassification,
      confidence: node.confidenceWeight,
      learnedAt: learnedAt(node),
    },
    validity: {
      validFrom: node.validFrom,
      validTo: node.validTo,
      current: node.validTo === null || Date.parse(node.validTo) > now,
      supersededBy: str(about["supersededBy"]),
      reason: str(about["invalidatedBecause"]),
      retraction,
    },
    derived,
    history,
  };
}
