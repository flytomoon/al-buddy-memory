/**
 * LangChain JS / LangGraph JS (`@langchain/core` ≥ 1, `@langchain/langgraph` ≥ 1).
 *
 * LangGraph's documented home for LONG-TERM memory (memory that outlives one
 * thread) is a `BaseStore` passed to `graph.compile({ store })` or
 * `createReactAgent({ store })`: nodes and tools read and write it by
 * namespace and key. Checkpointers are the other half — per-thread
 * conversation state — and stay whatever you use today. So this ships:
 *
 * - `AlBuddyMemoryStore` — a `BaseStore` on al-buddy-memory. A `put` is a
 *   governed, provenance-stamped fact; putting the same namespace+key again
 *   REPLACES the old fact by invalidating it (the old value stays in history);
 *   a delete (`put` of null) invalidates rather than erases. Erasure stays a
 *   deliberate, policy-judged `deleteNode` on the governed handle.
 * - `alBuddyMemoryTools(opts)` — remember / recall / invalidate / explain as
 *   LangChain tools, for agents that should decide when to use memory.
 */
import { tool } from "@langchain/core/tools";
import {
  BaseStore,
  type GetOperation,
  type Item,
  type ListNamespacesOperation,
  type Operation,
  type OperationResults,
  type PutOperation,
  type SearchOperation,
} from "@langchain/langgraph";

import { withOrigin, type Origin } from "../provenance.js";
import type { MemoryNode, MemoryStore } from "../types/memory.js";

import {
  explainInput,
  invalidateInput,
  memoryToolkit,
  recallInput,
  rememberInput,
  TOOL_DESCRIPTIONS,
  type MemoryIntegrationOptions,
  type MemoryToolkit,
} from "./shared.js";

export { openAgentMemory, type MemoryIntegrationOptions } from "./shared.js";

/** LangGraph's search result: an item and its relevance (not re-exported by @langchain/langgraph). */
type SearchItem = Item & { score?: number };

const FRAMEWORK = "langgraph";
const TAG = "langgraph";
const NS_TAG = "lg-ns:";
/** How many candidates a store search reads before namespace/filter narrowing. */
const SEARCH_POOL = 500;

interface StoredEntry {
  namespace: string[];
  key: string;
  value: Record<string, unknown>;
}

const nsTag = (namespace: readonly string[]): string => `${NS_TAG}${namespace.join("/")}`;

function entryOf(n: MemoryNode): StoredEntry | null {
  const e = n.contextualMetadata[TAG] as Partial<StoredEntry> | undefined;
  if (!e || !Array.isArray(e.namespace) || typeof e.key !== "string" || !e.value || typeof e.value !== "object") return null;
  return { namespace: e.namespace.map(String), key: e.key, value: e.value };
}

function textOf(value: Record<string, unknown>): string {
  for (const k of ["text", "content", "memory", "fact", "note"]) {
    if (typeof value[k] === "string" && (value[k] as string).trim()) return (value[k] as string).trim();
  }
  return JSON.stringify(value);
}

const startsWith = (ns: readonly string[], prefix: readonly string[]): boolean => prefix.every((p, i) => ns[i] === p);

function matches(ns: readonly string[], cond: { matchType: "prefix" | "suffix"; path: (string | "*")[] }): boolean {
  const seg = cond.matchType === "prefix" ? ns.slice(0, cond.path.length) : ns.slice(ns.length - cond.path.length);
  return seg.length === cond.path.length && cond.path.every((p, i) => p === "*" || p === seg[i]);
}

const filterHolds = (value: Record<string, unknown>, filter: Record<string, unknown> | undefined): boolean =>
  !filter || Object.entries(filter).every(([k, v]) => JSON.stringify(value[k]) === JSON.stringify(v));

/** A LangGraph long-term memory store backed by al-buddy-memory. */
export class AlBuddyMemoryStore extends BaseStore {
  private readonly store: MemoryStore;
  private readonly mem: MemoryToolkit;
  private readonly origin: Origin;

  constructor(opts: MemoryIntegrationOptions) {
    super();
    this.store = opts.store;
    this.mem = memoryToolkit(opts, FRAMEWORK);
    this.origin = { agent: opts.agent ?? FRAMEWORK, via: `al-buddy-memory/${FRAMEWORK}`, ...(opts.app !== undefined && { app: opts.app }) };
  }

  async batch<Op extends Operation[]>(operations: Op): Promise<OperationResults<Op>> {
    const out: unknown[] = [];
    for (const op of operations) {
      if ("key" in op && "value" in op) out.push(await this.doPut(op as PutOperation));
      else if ("key" in op) out.push(await this.doGet(op as GetOperation));
      else if ("namespacePrefix" in op) out.push(await this.doSearch(op as SearchOperation));
      else out.push(await this.doList(op as ListNamespacesOperation));
    }
    return out as OperationResults<Op>;
  }

  /** The live fact for a namespace + key, if any. */
  private async find(namespace: readonly string[], key: string): Promise<MemoryNode | null> {
    const nodes = await this.store.searchNodes({ tags: [nsTag(namespace)] });
    return nodes.find((n) => n.validTo === null && entryOf(n)?.key === key) ?? null;
  }

  private toItem(n: MemoryNode, e: StoredEntry): Item {
    const updated = n.temporalAnchors.at(-1)?.timestamp ?? n.validFrom;
    return { value: e.value, key: e.key, namespace: e.namespace, createdAt: new Date(n.validFrom), updatedAt: new Date(updated) };
  }

  private async doGet(op: GetOperation): Promise<Item | null> {
    const n = await this.find(op.namespace, op.key);
    const e = n && entryOf(n);
    return n && e ? this.toItem(n, e) : null;
  }

  private async doPut(op: PutOperation): Promise<void> {
    const previous = await this.find(op.namespace, op.key);
    if (op.value === null) {
      if (previous) await this.mem.invalidate({ id: previous.nodeId, reason: "deleted through the LangGraph store" });
      return;
    }
    const value = op.value as Record<string, unknown>;
    const saved = await this.store.addNode({
      provenance: "AIInferred",
      encryptionKeyRef: "local",
      memoryType: "Experience",
      privacyClassification: "Private",
      retentionTier: "FullRetention",
      content: { text: textOf(value) },
      contextualMetadata: withOrigin({ [TAG]: { namespace: [...op.namespace], key: op.key, value }, tags: [TAG, nsTag(op.namespace)] }, this.origin),
      confidenceWeight: 1,
      decayRate: 0,
      validFrom: new Date().toISOString(),
    });
    // A second put replaces the first — by invalidation, so the old value stays in history.
    if (previous) await this.mem.invalidate({ id: previous.nodeId, replacedBy: saved.nodeId, reason: "replaced through the LangGraph store" });
  }

  private async doSearch(op: SearchOperation): Promise<SearchItem[]> {
    const query = op.query?.trim();
    const nodes = await this.store.searchNodes({ ...(query ? { query } : {}), tags: [TAG], limit: SEARCH_POOL });
    const hits: SearchItem[] = [];
    nodes.forEach((n, rank) => {
      const e = entryOf(n);
      if (n.validTo !== null || !e || !startsWith(e.namespace, op.namespacePrefix) || !filterHolds(e.value, op.filter)) return;
      hits.push({ ...this.toItem(n, e), ...(query ? { score: 1 / (1 + rank) } : {}) });
    });
    const offset = op.offset ?? 0;
    return hits.slice(offset, offset + (op.limit ?? 10));
  }

  private async doList(op: ListNamespacesOperation): Promise<string[][]> {
    const nodes = await this.store.searchNodes({ tags: [TAG] });
    const seen = new Map<string, string[]>();
    for (const n of nodes) {
      const e = entryOf(n);
      if (n.validTo !== null || !e) continue;
      if (op.matchConditions && !op.matchConditions.every((c) => matches(e.namespace, c))) continue;
      const ns = op.maxDepth !== undefined ? e.namespace.slice(0, op.maxDepth) : e.namespace;
      seen.set(ns.join("/"), ns);
    }
    const all = [...seen.values()].sort((a, b) => a.join("/").localeCompare(b.join("/")));
    return all.slice(op.offset, op.offset + op.limit);
  }
}

/** The four memory tools as LangChain tools (JSON results). */
export function alBuddyMemoryTools(opts: MemoryIntegrationOptions) {
  const mem = memoryToolkit(opts, "langchain");
  const json = (v: unknown): string => JSON.stringify(v);
  return [
    tool(async ({ text }) => json(await mem.remember({ text })), { name: "remember", description: TOOL_DESCRIPTIONS.remember, schema: rememberInput }),
    tool(async ({ query, limit }) => json(await mem.recall({ query, limit })), { name: "recall", description: TOOL_DESCRIPTIONS.recall, schema: recallInput }),
    tool(async ({ id, reason, replacedBy }) => json(await mem.invalidate({ id, reason, replacedBy })), {
      name: "invalidate",
      description: TOOL_DESCRIPTIONS.invalidate,
      schema: invalidateInput,
    }),
    tool(async ({ id }) => json(await mem.explain({ id })), { name: "explain", description: TOOL_DESCRIPTIONS.explain, schema: explainInput }),
  ];
}
