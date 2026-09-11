/**
 * The neutral shape every adapter reduces an export to, and what the scorer
 * reads. Nothing here favours our own format: a fact is text plus whatever the
 * exporting system actually recorded about who asserted it, since when, until
 * when, and how sure it was. Missing means missing — adapters never invent.
 */
export interface ConformanceFact {
  id: string;
  text: string;
  /** Who/what asserted the fact, as the source system labels it. null = not recorded. */
  provenance: string | null;
  /** When the fact became true (or, failing that, when it was recorded). null = not recorded. */
  validFrom: string | null;
  /** When the fact stopped being true. null = still current (or the system has no such field). */
  validTo: string | null;
  /** [0,1] when recorded. */
  confidence: number | null;
  /** The fact that replaced this one, when the system records supersession. */
  supersededBy: string | null;
}

export interface ConformanceEdge {
  from: string;
  to: string;
  type: string;
  provenance: string | null;
}

/** What an adapter knows about the SYSTEM, beyond the facts in the sample. */
export interface SystemTraits {
  /** Can a fact be closed (validTo / superseded) while the record is kept? */
  invalidation: "kept" | "overwritten" | "deleted" | "expiry-only" | "unknown";
  /** Is there a published schema for the export? */
  schema: { published: boolean; url?: string };
  /** Does import(export(x)) reproduce x at the fact level? */
  roundTrip: "lossless" | "lossy" | "unknown";
  /** Facts are itemised (one record per fact) rather than free-text blobs. */
  itemised: boolean;
  notes?: string[];
}

export interface ConformanceInput {
  system: string;
  format: "portable" | "blocks" | "records";
  facts: ConformanceFact[];
  edges: ConformanceEdge[];
  traits: SystemTraits;
}
