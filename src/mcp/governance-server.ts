/**
 * The governance MCP server — a memory server that tells the calling
 * agent WHERE a fact came from, SINCE WHEN it has been true, and WHAT superseded
 * it, with every recall. 217 memory MCP servers hand agents facts; this one
 * hands them facts they can weigh.
 *
 * Tools: remember, recall, invalidate, pin, unpin, pinned. Every answer
 * carries provenance, validFrom, validTo, confidence, and — for a superseded
 * fact — the id of what replaced it. There is no erase tool; invalidation keeps
 * the record. The shipped server serves `serverStore(...)`, a governed handle.
 *
 * The server body is a plain function over a MemoryStore so it is testable
 * without a transport; `bin/al-buddy-memory-mcp.js` wires stdio.
 */
import { z } from "zod";
import type { AuditSink } from "../governance/audit.js";
import { govern } from "../governance/governed-store.js";
import { personalDefaults } from "../governance/samples.js";
import { withOrigin, type Origin } from "../provenance.js";

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

/**
 * The store the shipped server serves: the owner's memory behind the owner's
 * own policy, with the AI client as the AUDIENCE. So a secret an agent writes is
 * classified Sensitive and stays out of any AI's recall, Sealed facts never
 * reach the client, erasure is the owner's alone, and every call is audited. It
 * served the raw store until 0.4.0 — a "governance" server that applied none.
 */
export function serverStore(inner: MemoryStore, opts: { owner?: string; audit?: AuditSink } = {}): MemoryStore {
  const owner = opts.owner ?? "owner";
  return govern(inner, {
    policies: [personalDefaults({ owner })],
    context: () => ({ actor: owner, audience: "mcp-client" }),
    audit: opts.audit,
  });
}

export interface GovernanceDeps {
  store: MemoryStore;
  /** Who is writing, asked at each write. The shipped server answers from the MCP handshake. */
  origin?: () => Origin | undefined;
  embedder?: Embedder;
  now?: () => Date;
  encryptionKeyRef?: string;
}

/**
 * What every connecting client is told about using this server. Claude Desktop
 * connected five times and never called a tool: a client that is not told when to
 * recall and what to remember does neither (founder, 2026-09-15). The first 512
 * characters stand alone, because some clients read only that much.
 */
export const SERVER_INSTRUCTIONS = [
  "This is the user's long-term memory, shared across their assistants.",
  "At the start of a conversation, and when the user mentions a person, project, preference or past decision, call recall with a short keyword query and use what it returns; each fact says who asserted it and since when.",
  "When the user states something durable (a preference, decision, commitment, or fact about their life, people or work), call remember with one plain sentence.",
  "Never remember secrets, small talk or one-off requests.",
  "When a fact stops being true, call invalidate with its id; nothing is deleted.",
  "Use pin only for rules that belong in every conversation.",
].join(" ");

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
        contextualMetadata: withOrigin({}, deps.origin?.()),
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
      const origin = deps.origin?.();
      return pins.pin({ text: input.text, ...(input.label && { label: input.label }), ...(origin && { origin }) });
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
  const server = new McpServer({ name: "al-buddy-memory", version: "0.4.1" }, { instructions: SERVER_INSTRUCTIONS });
  // The app that wrote a fact is the client that connected, as it announced itself
  // in the handshake — the model cannot change that.
  const tools = governanceTools({
    ...deps,
    origin:
      deps.origin ??
      (() => {
        const client = server.server.getClientVersion();
        return client ? { app: client.name, appVersion: client.version, via: "mcp" } : { via: "mcp" };
      }),
  });
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
