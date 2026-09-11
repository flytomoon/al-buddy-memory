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

function createdAt(n: MemoryNode): string {
  return n.temporalAnchors.find((a) => a.event === "created")?.timestamp ?? n.validFrom;
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
    .sort((a, b) => createdAt(a).localeCompare(createdAt(b)))
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
