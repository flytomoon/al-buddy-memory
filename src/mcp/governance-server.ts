/**
 * The governance MCP server — a memory server that tells the calling
 * agent WHERE a fact came from, SINCE WHEN it has been true, and WHAT superseded
 * it, with every recall. 217 memory MCP servers hand agents facts; this one
 * hands them facts they can weigh.
 *
 * Tools: remember, recall, invalidate, pin, unpin, pinned, export. Every
 * answer carries provenance, validFrom, validTo, confidence, and — for a
 * superseded fact — the id of what replaced it. Nothing is ever deleted.
 *
 * The server body is a plain function over a MemoryStore so it is testable
 * without a transport; `bin/al-buddy-memory-mcp.js` wires stdio.
 */
import { z } from "zod";

import { HybridRetriever } from "../hybrid-retriever.js";
import { PinnedBlocks } from "../pinned.js";
import type { Embedder } from "../embedder.js";
import type { MemoryNode, MemoryStore } from "../types/memory.js";

export interface GovernedFact {
  id: string;
  text: string;
  provenance: MemoryNode["provenance"];
  memoryType: MemoryNode["memoryType"];
  validFrom: string;
  validTo: string | null;
  /** True while validTo is null. */
  current: boolean;
  confidence: number;
  /** The fact that replaced this one, when invalidate() named one. */
  supersededBy: string | null;
  /** Ids of the raw facts a derived fact rests on (from consolidate()). */
  derivedFrom: string[];
  recordedAt: string;
}

export function toGovernedFact(n: MemoryNode): GovernedFact {
  const meta = n.contextualMetadata;
  return {
    id: n.nodeId,
    text: n.content.text,
    provenance: n.provenance,
    memoryType: n.memoryType,
    validFrom: n.validFrom,
    validTo: n.validTo,
    current: n.validTo === null,
    confidence: n.confidenceWeight,
    supersededBy: typeof meta["supersededBy"] === "string" ? (meta["supersededBy"] as string) : null,
    derivedFrom: Array.isArray(meta["derivedFrom"]) ? (meta["derivedFrom"] as string[]) : [],
    recordedAt: n.temporalAnchors.find((a) => a.event === "created")?.timestamp ?? n.validFrom,
  };
}

export interface GovernanceDeps {
  store: MemoryStore;
  embedder?: Embedder;
  now?: () => Date;
  encryptionKeyRef?: string;
}

/** The tool implementations, transport-free. */
export function governanceTools(deps: GovernanceDeps) {
  const now = deps.now ?? (() => new Date());
  const pins = new PinnedBlocks(deps.store, { now, ...(deps.encryptionKeyRef && { encryptionKeyRef: deps.encryptionKeyRef }) });
  const retriever = deps.embedder ? new HybridRetriever(deps.store, deps.embedder) : null;
  return {
    async remember(input: { text: string; provenance?: MemoryNode["provenance"] | undefined; memoryType?: MemoryNode["memoryType"] | undefined; confidence?: number | undefined }): Promise<GovernedFact> {
      const text = input.text.trim();
      if (!text) throw new Error("remember: text is required");
      const saved = await deps.store.addNode({
        provenance: input.provenance ?? "UserInput",
        encryptionKeyRef: deps.encryptionKeyRef ?? "local",
        memoryType: input.memoryType ?? "Experience",
        privacyClassification: "Private",
        retentionTier: "FullRetention",
        content: { text },
        contextualMetadata: {},
        confidenceWeight: Math.max(0, Math.min(1, input.confidence ?? 1)),
        decayRate: 0,
        validFrom: now().toISOString(),
      });
      return toGovernedFact(saved);
    },
    async recall(input: { query: string; limit?: number | undefined; includeSuperseded?: boolean | undefined }): Promise<GovernedFact[]> {
      const limit = Math.max(1, Math.min(50, input.limit ?? 8));
      let nodes: MemoryNode[];
      if (retriever) nodes = await retriever.recall(input.query, { limit: limit * 2 });
      else nodes = await deps.store.searchNodes({ query: input.query, limit: limit * 2 });
      const facts = nodes.map(toGovernedFact).filter((f) => input.includeSuperseded || f.current);
      return facts.slice(0, limit);
    },
    /** Close a fact's validity. Never deletes; optionally names the replacement. */
    async invalidate(input: { id: string; replacedBy?: string | undefined; reason?: string | undefined }): Promise<GovernedFact> {
      const node = await deps.store.getNode(input.id);
      if (!node) throw new Error(`invalidate: no fact ${input.id}`);
      if (node.validTo !== null) return toGovernedFact(node);
      const at = now().toISOString();
      const updated = await deps.store.updateNode(input.id, {
        validTo: at,
        contextualMetadata: { ...node.contextualMetadata, ...(input.replacedBy && { supersededBy: input.replacedBy }), ...(input.reason && { invalidatedBecause: input.reason }), invalidatedAt: at },
      });
      return toGovernedFact(updated);
    },
    async pin(input: { text: string; label?: string | undefined }) {
      return pins.pin({ text: input.text, ...(input.label && { label: input.label }) });
    },
    async unpin(input: { id: string }) {
      return { unpinned: await pins.unpin(input.id) };
    },
    async pinned() {
      return { blocks: await pins.list(), rendered: await pins.render() };
    },
  };
}

/** Wire the tools onto an MCP server instance (stdio transport is the bin's job). */
export async function attachGovernanceServer(deps: GovernanceDeps): Promise<{ server: unknown; connectStdio: () => Promise<void> }> {
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  const tools = governanceTools(deps);
  const server = new McpServer({ name: "al-buddy-memory", version: "0.3.5" });
  const json = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v, null, 2) }] });
  server.tool("remember", "Store a fact with its provenance. Returns the fact with validFrom, provenance and confidence.", {
    text: z.string(), provenance: z.enum(["UserInput", "AIInferred", "GuardianAdded", "SystemGenerated"]).optional(), confidence: z.number().min(0).max(1).optional(),
  }, async (a) => json(await tools.remember(a)));
  server.tool("recall", "Find facts. Every result says who asserted it, since when it has been true, whether it is still current, and what superseded it.", {
    query: z.string(), limit: z.number().int().min(1).max(50).optional(), includeSuperseded: z.boolean().optional(),
  }, async (a) => json(await tools.recall(a)));
  server.tool("invalidate", "A fact stopped being true: close its validity (never delete), optionally naming what replaced it.", {
    id: z.string(), replacedBy: z.string().optional(), reason: z.string().optional(),
  }, async (a) => json(await tools.invalidate(a)));
  server.tool("pin", "Pin a fact into the always-in-prompt tier.", { text: z.string(), label: z.string().optional() }, async (a) => json(await tools.pin(a)));
  server.tool("unpin", "Unpin a fact (its validity closes; it is kept).", { id: z.string() }, async (a) => json(await tools.unpin(a)));
  server.tool("pinned", "The pinned tier, as a list and as the rendered prompt block.", {}, async () => json(await tools.pinned()));
  return { server, connectStdio: async () => { await server.connect(new StdioServerTransport()); } };
}
