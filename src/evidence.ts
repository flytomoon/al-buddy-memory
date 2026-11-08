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
import { compareRecency } from "./decay.js";
import { recallCount } from "./access.js";
import { isStateNode } from "./state.js";
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
  /** Transcript checks attempted and completed. A callback error rejects the pass. */
  crossChecked: number;
}

export interface TranscriptContradiction {
  /** A newer raw turn, not a derived node. */
  nodeId: string;
  /** Exact words in that turn that contradict the conclusion. */
  quote: string;
}

export interface VerifyOptions {
  now?: () => Date;
  by?: string;
  /** Injected judgement; null means no contradiction. This library makes no model calls. */
  crossCheck?: (conclusion: MemoryNode, newerRaw: readonly MemoryNode[]) => Promise<TranscriptContradiction | null>;
  /** Bound model calls per pass. Highest access and volatile states are checked first. */
  maxCrossChecks?: number;
}

/** One-tap acknowledgement: keep the retraction and raw evidence; clear only its review flag. */
export async function confirmTranscriptRetraction(store: MemoryStore, nodeId: string): Promise<MemoryNode> {
  const node = await store.getNode(nodeId);
  if (!node || node.validTo === null || (node.contextualMetadata["retraction"] as { by?: string } | undefined)?.by !== "transcript cross-check") throw new Error(`no transcript retraction for ${nodeId}`);
  if (!node.contextualMetadata["pendingRetractionConfirmation"]) return node;
  const { pendingRetractionConfirmation: _pending, ...metadata } = node.contextualMetadata;
  return store.updateNode(nodeId, { contextualMetadata: metadata });
}

const EVERY_TIER = { retentionTier: [...RETENTION_TIERS], privacyClassification: [...PRIVACY_CLASSIFICATIONS] };
const privacyRank: Record<MemoryNode["privacyClassification"], number> = { Public: 0, Private: 1, Sensitive: 2, Sealed: 3 };

/**
 * Check every live derived fact's evidence against its sources, now. One whose
 * evidence no longer holds is RETRACTED — `validTo` and a `retraction` saying
 * why — never deleted: it was believed, and the record says so. Through a
 * governed handle, the handle decides what may be read and changed.
 */
export async function verifyDerived(store: MemoryStore, opts: VerifyOptions = {}): Promise<VerifyReport> {
  const now = (opts.now ?? (() => new Date()))().toISOString();
  const report: VerifyReport = { checked: 0, retracted: [], unverifiable: [], crossChecked: 0 };
  const nodes = await store.searchNodes(EVERY_TIER);
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  const derived = nodes.filter((n) => n.provenance === "AIInferred" && (derivedFromOf(n).length > 0 || isStateNode(n)));
  derived.sort((a, b) => (Number(isStateNode(b)) * (1 + recallCount(b))) - (Number(isStateNode(a)) * (1 + recallCount(a))) || recallCount(b) - recallCount(a) || compareRecency(a, b));
  const cap = opts.maxCrossChecks ?? 50;
  if (!Number.isInteger(cap) || cap < 0) throw new Error("maxCrossChecks must be an integer >= 0");
  for (const n of derived) {
    if (n.validTo !== null && Date.parse(n.validTo) <= Date.parse(now)) continue;
    report.checked++;
    const evidence = evidenceOf(n);
    if (evidence.length === 0 && derivedFromOf(n).length > 0) {
      report.unverifiable.push(n.nodeId);
    } else if (evidence.length > 0) {
      const problem = evidenceProblem(derivedFromOf(n), evidence, (id) => (byId.get(id) ?? undefined)?.content.text);
      if (problem !== null) {
        const reason = `evidence no longer holds: ${problem}`;
        await store.updateNode(n.nodeId, { validTo: now, contextualMetadata: { ...n.contextualMetadata, retraction: { at: now, by: opts.by ? `verifyDerived (${opts.by})` : "verifyDerived", reason } } });
        report.retracted.push({ nodeId: n.nodeId, reason });
        continue;
      }
    }
    if (!opts.crossCheck || report.crossChecked >= cap) continue;
    const lastCheck = n.contextualMetadata["lastTranscriptCrossCheckAt"];
    const interval = isStateNode(n) || recallCount(n) >= 3 ? 86_400_000 : 7 * 86_400_000;
    if (typeof lastCheck === "string" && Number.isFinite(Date.parse(lastCheck)) && Date.parse(now) - Date.parse(lastCheck) < interval) continue;
    const newerRaw = nodes.filter((raw) => raw.provenance !== "AIInferred" && raw.memoryType === "Conversation" && compareRecency(raw, n) < 0 && raw.privacyClassification !== "Sealed" && privacyRank[raw.privacyClassification] <= privacyRank[n.privacyClassification]).sort(compareRecency).slice(0, 50);
    if (newerRaw.length === 0) continue;
    report.crossChecked++;
    const conflict = await opts.crossCheck(n, newerRaw);
    if (!conflict) {
      const fresh = await store.getNode(n.nodeId);
      if (fresh && fresh.validTo === null) await store.updateNode(n.nodeId, { contextualMetadata: { ...fresh.contextualMetadata, lastTranscriptCrossCheckAt: now } }, "verified");
      continue;
    }
    const source = newerRaw.find((raw) => raw.nodeId === conflict.nodeId);
    if (!source || !quoteHolds(conflict.quote, source.content.text)) throw new Error(`crossCheck returned unsupported contradiction for ${n.nodeId}`);
    const reason = `newer raw turn ${source.nodeId} contradicts this conclusion: ${conflict.quote}`;
    const fresh = await store.getNode(n.nodeId);
    if (!fresh || fresh.validTo !== null) continue;
    await store.updateNode(n.nodeId, { validTo: now, contextualMetadata: { ...fresh.contextualMetadata, retraction: { at: now, by: "transcript cross-check", reason }, pendingRetractionConfirmation: { sourceNodeId: source.nodeId, quote: conflict.quote } } });
    report.retracted.push({ nodeId: n.nodeId, reason });
  }
  return report;
}
