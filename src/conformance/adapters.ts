/**
 * Adapters: reduce a vendor export to {@link ConformanceInput}. Each one maps
 * only what the format actually records. When a field does not exist in the
 * source, the fact carries null and the dimension scores accordingly — the
 * benchmark's value is that it cannot be flattered.
 */
import { InMemoryStore } from "../in-memory-store.js";
import { exportPortable, importPortable, type PortableExport } from "../memory-portability.js";
import type { ConformanceEdge, ConformanceFact, ConformanceInput } from "./model.js";

export type ExportFormat = ConformanceInput["format"];

// --- al-buddy-memory portable format ---------------------------------------

function canonical(v: unknown): string {
  return JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.keys(x as object).sort().map((k) => [k, (x as Record<string, unknown>)[k]])) : x));
}

/** import(export(x)) === x at the node/edge level, proven on this very artifact. */
export async function proveRoundTrip(artifact: PortableExport): Promise<boolean> {
  const stores = new Map<string, InMemoryStore>();
  await importPortable(artifact, (p) => {
    let s = stores.get(p);
    if (!s) { s = new InMemoryStore(); stores.set(p, s); }
    return s;
  });
  const again = await exportPortable(new Map(stores));
  const strip = (a: PortableExport) => a.projects.map((p) => ({ project: p.project, nodes: [...p.nodes].sort((x, y) => x.nodeId.localeCompare(y.nodeId)), edges: [...p.edges].sort((x, y) => x.edgeId.localeCompare(y.edgeId)), versions: [...(p.versions ?? [])].sort((x, y) => x.versionId.localeCompare(y.versionId)) })).sort((x, y) => x.project.localeCompare(y.project));
  return canonical(strip(artifact)) === canonical(strip(again));
}

export async function fromPortable(artifact: PortableExport, opts: { system?: string } = {}): Promise<ConformanceInput> {
  const facts: ConformanceFact[] = [];
  const edges: ConformanceEdge[] = [];
  for (const p of artifact.projects) {
    for (const n of p.nodes) {
      const meta = n.contextualMetadata ?? {};
      facts.push({
        id: n.nodeId,
        text: n.content.text,
        provenance: n.provenance ?? null,
        validFrom: n.validFrom ?? null,
        validTo: n.validTo ?? null,
        confidence: typeof n.confidenceWeight === "number" ? n.confidenceWeight : null,
        supersededBy: typeof meta["supersededBy"] === "string" ? (meta["supersededBy"] as string) : null,
      });
    }
    for (const e of p.edges) edges.push({ from: e.sourceNodeId, to: e.targetNodeId, type: e.relationshipType, provenance: e.provenance ?? null });
  }
  let roundTrip: "lossless" | "lossy" | "unknown" = "unknown";
  try { roundTrip = (await proveRoundTrip(artifact)) ? "lossless" : "lossy"; } catch { roundTrip = "lossy"; }
  return {
    system: opts.system ?? "al-buddy-memory",
    format: "portable",
    facts,
    edges,
    traits: { invalidation: "kept", schema: { published: true, url: "docs/portable-format.schema.json" }, roundTrip, itemised: true },
  };
}

// --- Block-style agent files ------------------------------------------------
// Shape: { agents: [{ name, block_ids }], blocks: [{ id, label, value, description }] }.
// Each block is one free-text value the agent edits in place.

interface AgentBlock { id?: string; label?: string; value?: string; description?: string; read_only?: boolean }
interface BlocksFile { agents?: Array<{ name?: string; block_ids?: string[] }>; blocks?: AgentBlock[]; created_at?: string }

export function parseBlocks(raw: string | object): BlocksFile {
  let v: unknown = typeof raw === "string" ? JSON.parse(raw) : raw;
  // Some tools ship these double-encoded: a JSON string containing the JSON document.
  if (typeof v === "string") v = JSON.parse(v);
  if (!v || typeof v !== "object" || !Array.isArray((v as BlocksFile).blocks)) throw new Error("not a block-style agent file: no blocks[]");
  return v as BlocksFile;
}

export function fromBlocks(raw: string | object): ConformanceInput {
  const af = parseBlocks(raw);
  const blocks = af.blocks ?? [];
  const facts: ConformanceFact[] = blocks.map((b, i) => ({
    id: b.id ?? `block-${i}`,
    text: (b.value ?? "").trim(),
    provenance: null, // a block is edited in place by the agent; no per-fact author is recorded
    validFrom: null, // blocks carry no timestamps; only the file has created_at
    validTo: null,
    confidence: null,
    supersededBy: null,
  }));
  const agent = af.agents?.[0]?.name;
  return {
    system: `Block-style agent file${agent ? ` (${agent})` : ""}`,
    format: "blocks",
    facts,
    edges: [],
    traits: {
      invalidation: "overwritten",
      schema: { published: true },
      roundTrip: "lossless", // the agent round-trips; the facts inside its blocks do not itemise
      itemised: false,
      notes: [`${blocks.length} memory blocks (${blocks.map((b) => b.label ?? "?").join(", ")}); each block is one free-text value edited in place`, af.created_at ? `file created ${af.created_at}` : "no file timestamp"],
    },
  };
}

// --- Flat memory records ----------------------------------------------------
// Shape: { results: [{ id, memory, created_at, updated_at, metadata, expiration_date? }] } or a bare array.

interface MemoryRecord { id?: string; memory?: string; created_at?: string | null; updated_at?: string | null; metadata?: Record<string, unknown> | null; user_id?: string; expiration_date?: string | null; score?: number }

export function parseRecords(raw: string | object): MemoryRecord[] {
  const v: unknown = typeof raw === "string" ? JSON.parse(raw) : raw;
  const list = Array.isArray(v) ? v : v && typeof v === "object" && Array.isArray((v as { results?: unknown }).results) ? (v as { results: unknown[] }).results : null;
  if (!list || !list.every((m) => m && typeof m === "object" && typeof (m as MemoryRecord).memory === "string")) throw new Error("not a flat memory-records export: expected results[] of {memory}");
  return list as MemoryRecord[];
}

export function fromRecords(raw: string | object): ConformanceInput {
  const mems = parseRecords(raw);
  const facts: ConformanceFact[] = mems.map((m, i) => ({
    id: m.id ?? `mem-${i}`,
    text: (m.memory ?? "").trim(),
    provenance: null, // metadata is free-form; no provenance field in the schema
    validFrom: m.created_at ?? null,
    validTo: null, // expiration_date is a future expiry, not a closed validity
    confidence: null, // `score` is a search-time similarity, not a stored confidence
    supersededBy: null,
  }));
  const anyExpiry = mems.some((m) => m.expiration_date);
  return {
    system: "Flat memory records",
    format: "records",
    facts,
    edges: [],
    traits: {
      invalidation: "expiry-only",
      schema: { published: true },
      roundTrip: "unknown", // the record shape is stable, but no lossless import is defined for it
      itemised: true,
      notes: ["records are rewritten in place on update; per-record history events, where the source keeps them, are not part of the export", anyExpiry ? "expiration_date present on some memories" : "no expiration_date in the sample"],
    },
  };
}

// --- Detection ---------------------------------------------------------------

export function detectFormat(raw: string | object): ExportFormat {
  let v: unknown = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (typeof v === "string") v = JSON.parse(v);
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o["formatVersion"] === "string" && Array.isArray(o["projects"])) return "portable";
    if (Array.isArray(o["blocks"]) && Array.isArray(o["agents"])) return "blocks";
    if (Array.isArray(o["results"])) return "records";
  }
  if (Array.isArray(v)) return "records";
  throw new Error("could not detect the export format (expected al-buddy-memory portable, a block-style agent file, or flat memory records)");
}

export async function toConformanceInput(raw: string | object, format?: ExportFormat): Promise<ConformanceInput> {
  const f = format ?? detectFormat(raw);
  if (f === "blocks") return fromBlocks(raw);
  if (f === "records") return fromRecords(raw);
  let v: unknown = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (typeof v === "string") v = JSON.parse(v);
  return fromPortable(v as PortableExport);
}
