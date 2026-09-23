/**
 * The words a conclusion rests on, and whether they still hold.
 *
 * A derived fact records, for each source it cites, the exact passage it rests
 * on: `contextualMetadata.evidence = [{ nodeId, quote }]`. The quote must appear
 * in that source's text (whitespace-normalised: line breaks and runs of spaces
 * count as one space), so a conclusion can always be shown next to what it was
 * drawn from, and a conclusion its sources do not say is refused rather than
 * stored. Raw text is immutable, so evidence that held when written holds for
 * as long as the source exists — except evidence that arrived by import, or was
 * written by an older library, which is why `verifyDerived` exists.
 *
 * Found in our 2026-09-22 review of the erase path: a derived fact cited its
 * sources by id, and nothing checked that the sources said it.
 */
import { derivedFromOf } from "./derived.js";
import { PRIVACY_CLASSIFICATIONS, RETENTION_TIERS } from "./types/memory.js";
import type { MemoryNode, MemoryStore } from "./types/memory.js";

export const EVIDENCE = "evidence";

export interface EvidenceQuote {
  nodeId: string;
  quote: string;
}

const squash = (s: string): string => s.replace(/\s+/g, " ").trim();

/** Whether `quote` appears in `text`, line breaks and runs of spaces counting as one space. */
export function quoteHolds(quote: string, text: string): boolean {
  const q = squash(quote);
  return q.length > 0 && squash(text).includes(q);
}

/** The evidence a fact records, in the documented shape, or [] when it records none. */
export function evidenceOf(node: Pick<MemoryNode, "contextualMetadata">): EvidenceQuote[] {
  const raw = node.contextualMetadata[EVIDENCE];
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((e): e is EvidenceQuote => e !== null && typeof e === "object" && typeof (e as EvidenceQuote).nodeId === "string" && typeof (e as EvidenceQuote).quote === "string")
    .map((e) => ({ nodeId: e.nodeId, quote: e.quote }));
}

/**
 * Why `evidence` does not support a conclusion resting on `sources`, or null
 * when it does: every source quoted at least once, every quote from a cited
 * source, every quote found in that source's text.
 */
export function evidenceProblem(sources: readonly string[], evidence: readonly EvidenceQuote[], textOf: (nodeId: string) => string | undefined): string | null {
  for (const e of evidence) {
    if (!sources.includes(e.nodeId)) return `evidence cites ${e.nodeId}, which the conclusion does not rest on`;
  }
  for (const id of sources) {
    const quotes = evidence.filter((e) => e.nodeId === id);
    if (quotes.length === 0) return `no quote from source ${id}`;
    const text = textOf(id);
    if (text === undefined) return `source ${id} is gone`;
    for (const q of quotes) if (!quoteHolds(q.quote, text)) return `quote not found in source ${id}`;
  }
  return null;
}

export interface VerifyReport {
  /** Live conclusions looked at. */
  checked: number;
  /** Retracted now, and why. */
  retracted: { nodeId: string; reason: string }[];
  /** Live conclusions that record no evidence (written before 0.6.0): left alone, named. */
  unverifiable: string[];
}

const EVERY_TIER = { retentionTier: [...RETENTION_TIERS], privacyClassification: [...PRIVACY_CLASSIFICATIONS] };

/**
 * Check every live derived fact's evidence against its sources, now. One whose
 * evidence no longer holds is RETRACTED — `validTo` and a `retraction` saying
 * why — never deleted: it was believed, and the record says so. Through a
 * governed handle, the handle decides what may be read and changed.
 */
export async function verifyDerived(store: MemoryStore, opts: { now?: () => Date; by?: string } = {}): Promise<VerifyReport> {
  const now = (opts.now ?? (() => new Date()))().toISOString();
  const report: VerifyReport = { checked: 0, retracted: [], unverifiable: [] };
  const nodes = await store.searchNodes(EVERY_TIER);
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  for (const n of nodes) {
    if (n.provenance !== "AIInferred" || derivedFromOf(n).length === 0) continue;
    if (n.validTo !== null && Date.parse(n.validTo) <= Date.parse(now)) continue;
    report.checked++;
    const evidence = evidenceOf(n);
    if (evidence.length === 0) {
      report.unverifiable.push(n.nodeId);
      continue;
    }
    const problem = evidenceProblem(derivedFromOf(n), evidence, (id) => (byId.get(id) ?? undefined)?.content.text);
    if (problem === null) continue;
    const reason = `evidence no longer holds: ${problem}`;
    await store.updateNode(n.nodeId, { validTo: now, contextualMetadata: { ...n.contextualMetadata, retraction: { at: now, by: opts.by ? `verifyDerived (${opts.by})` : "verifyDerived", reason } } });
    report.retracted.push({ nodeId: n.nodeId, reason });
  }
  return report;
}
