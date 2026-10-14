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
/** Exactly this namespace: `lg-ns:users/u1`. */
const NS_TAG = "lg-ns:";
/** Somewhere below this namespace: an entry in users/u1/prefs carries `lg-in:users` and `lg-in:users/u1`. */
const IN_TAG = "lg-in:";

interface StoredEntry {
  namespace: string[];
  key: string;
  value: Record<string, unknown>;
}

const nsTag = (namespace: readonly string[]): string => `${NS_TAG}${namespace.join("/")}`;
const inTag = (namespace: readonly string[]): string => `${IN_TAG}${namespace.join("/")}`;
/** The tags of an entry in `namespace`: its own, and one for each namespace it sits inside. */
const entryTags = (namespace: readonly string[]): string[] => [
  TAG,
  nsTag(namespace),
  ...namespace.slice(0, -1).map((_, i) => inTag(namespace.slice(0, i + 1))),
];
/**
 * Entries written by 0.11.0 or earlier carry only their own namespace's tag, so
 * a search of a shorter prefix names their namespaces too. Past this many of
 * them it reads every entry instead of naming each.
 */
const MAX_OLDER_NAMESPACES = 100;

/** A nested entry with no `lg-in:` tags: written by 0.11.0 or earlier. */
function writtenBeforePrefixTags(n: MemoryNode, e: StoredEntry): boolean {
  const tags = n.contextualMetadata["tags"];
  return e.namespace.length > 1 && !(Array.isArray(tags) && tags.includes(inTag(e.namespace.slice(0, 1))));
}

/** The tags that find every entry at or below `prefix` in one read (`[]` is every entry). */
function prefixTags(prefix: readonly string[], olderNamespaces: readonly string[][]): string[] {
  if (prefix.length === 0) return [TAG];
  const older = olderNamespaces.filter((ns) => ns.length > prefix.length && startsWith(ns, prefix));
  if (older.length > MAX_OLDER_NAMESPACES) return [TAG];
  return [nsTag(prefix), inTag(prefix), ...older.map(nsTag)];
}

/** Puts in flight, per memory handle and namespace + key, so two puts of one key run one after the other. */
const putsInFlight = new WeakMap<MemoryStore, Map<string, Promise<void>>>();

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
const sameNamespace = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && startsWith(a, b);

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
  /** The namespaces of live entries written by 0.11.0 or earlier, read once, on the first prefix search. */
  private olderNamespaces: Promise<string[][]> | undefined;

  constructor(opts: MemoryIntegrationOptions) {
    super();
    this.store = opts.store;
    this.mem = memoryToolkit(opts, FRAMEWORK);
    this.origin = { agent: opts.agent ?? FRAMEWORK, via: `al-buddy-memory/${FRAMEWORK}`, ...(opts.app !== undefined && { app: opts.app }) };
  }

  async batch<Op extends Operation[]>(operations: Op): Promise<OperationResults<Op>> {
    const out: unknown[] = [];
    for (const op of operations) {
      if ("key" in op && "value" in op) out.push(await this.putInTurn(op as PutOperation));
      else if ("key" in op) out.push(await this.doGet(op as GetOperation));
      else if ("namespacePrefix" in op) out.push(await this.doSearch(op as SearchOperation));
      else out.push(await this.doList(op as ListNamespacesOperation));
    }
    return out as OperationResults<Op>;
  }

  /** The live fact for a namespace + key, if any. */
  private async find(namespace: readonly string[], key: string): Promise<MemoryNode | null> {
    const nodes = await this.store.searchNodes({ tags: [nsTag(namespace)], validAt: new Date().toISOString() });
    return (
      nodes.find((n) => {
        const e = entryOf(n);
        // The tag joins segments with "/", so ["a/b"] and ["a", "b"] share one: compare the namespace itself.
        return n.validTo === null && e !== null && e.key === key && sameNamespace(e.namespace, namespace);
      }) ?? null
    );
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

  /**
   * A put waits for any earlier put of the same namespace + key on this handle.
   * Two at once both found no live fact (or the same one) and both wrote, which
   * left two live facts for one key. In-process only: another process writing
   * the same key is not queued.
   */
  private putInTurn(op: PutOperation): Promise<void> {
    let queues = putsInFlight.get(this.store);
    if (!queues) putsInFlight.set(this.store, (queues = new Map()));
    const id = JSON.stringify([op.namespace, op.key]);
    const run = (queues.get(id) ?? Promise.resolve()).then(() => this.doPut(op));
    // The queue's tail never rejects, so one failed put does not fail the next.
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    queues.set(id, tail);
    void tail.then(() => {
      if (queues.get(id) === tail) queues.delete(id);
    });
    return run;
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
      contextualMetadata: withOrigin({ [TAG]: { namespace: [...op.namespace], key: op.key, value }, tags: entryTags(op.namespace) }, this.origin),
      confidenceWeight: 1,
      decayRate: 0,
      validFrom: new Date().toISOString(),
    });
    // A second put replaces the first — by invalidation, so the old value stays in history.
    if (previous) await this.mem.invalidate({ id: previous.nodeId, replacedBy: saved.nodeId, reason: "replaced through the LangGraph store" });
  }

  private async doSearch(op: SearchOperation): Promise<SearchItem[]> {
    const query = op.query?.trim();
    const validAt = new Date().toISOString();
    // The namespace and the current-only rule go into the store's read, with no
    // limit: the store ranks what is in the namespace and the page is cut from
    // that. A fixed pool of the newest 500 entries used to be read first, so
    // older entries in a quiet namespace, and every page past the pool, were lost.
    const older = op.namespacePrefix.length > 0 ? await this.findOlderNamespaces() : [];
    const nodes = await this.store.searchNodes({ ...(query ? { query } : {}), tags: prefixTags(op.namespacePrefix, older), validAt });
    const hits: SearchItem[] = [];
    for (const n of nodes) {
      const e = entryOf(n);
      // Tags join segments with "/", so ["a/b"] answers for ["a", "b"]: the namespace itself decides.
      if (n.validTo !== null || !e || !startsWith(e.namespace, op.namespacePrefix) || !filterHolds(e.value, op.filter)) continue;
      hits.push({ ...this.toItem(n, e), ...(query ? { score: 1 / (1 + hits.length) } : {}) });
    }
    const offset = op.offset ?? 0;
    return hits.slice(offset, offset + (op.limit ?? 10));
  }

  /**
   * One read of every live entry, on the first prefix search of this adapter;
   * a failed read is tried again by the next search. Nothing writes entries
   * without prefix tags any more, so the list only goes stale by shrinking (an
   * older entry replaced or deleted), and naming a namespace with nothing left
   * in it costs nothing.
   */
  private findOlderNamespaces(): Promise<string[][]> {
    if (!this.olderNamespaces) {
      const reading = this.store.searchNodes({ tags: [TAG], validAt: new Date().toISOString() }).then((nodes) => {
        const seen = new Map<string, string[]>();
        for (const n of nodes) {
          const e = entryOf(n);
          if (n.validTo === null && e && writtenBeforePrefixTags(n, e)) seen.set(JSON.stringify(e.namespace), e.namespace);
        }
        return [...seen.values()];
      });
      this.olderNamespaces = reading;
      reading.catch(() => {
        if (this.olderNamespaces === reading) this.olderNamespaces = undefined;
      });
    }
    return this.olderNamespaces;
  }

  private async doList(op: ListNamespacesOperation): Promise<string[][]> {
    const nodes = await this.store.searchNodes({ tags: [TAG], validAt: new Date().toISOString() });
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
