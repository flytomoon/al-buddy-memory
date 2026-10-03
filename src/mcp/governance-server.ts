/**
 * The governance MCP server — a memory server that tells the calling
 * agent WHERE a fact came from, SINCE WHEN it has been true, and WHAT superseded
 * it, with every recall. 217 memory MCP servers hand agents facts; this one
 * hands them facts they can weigh.
 *
 * Tools: remember, recall, history, explain, invalidate, pin, unpin, pinned, export. Every answer
 * carries provenance, validFrom, validTo, confidence, and — for a superseded
 * fact — the id of what replaced it. There is no erase tool; invalidation keeps
 * the record. The shipped server serves `serverStore(...)`, a governed handle.
 *
 * The server body is a plain function over a MemoryStore so it is testable
 * without a transport; `bin/al-buddy-memory-mcp.js` wires stdio.
 */
import { explainFact, type Explanation } from "../explain.js";
import { defineMentalModel, getMentalModel, listMentalModels, QUESTION_MAX_CHARS, type MentalModel } from "../mental-models.js";
import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute } from "node:path";

import { z } from "zod";
import type { AuditSink } from "../governance/audit.js";
import { exportView, govern } from "../governance/governed-store.js";
import { looksSecret, personalDefaults } from "../governance/samples.js";
import { knownOrigin, readOrigin, withOrigin, type Origin } from "../provenance.js";

import { HybridRetriever } from "../hybrid-retriever.js";
import { PinnedBlocks } from "../pinned.js";
import { queryTokens, visibleRelevance } from "../query-filter.js";
import { isHistoryCapable } from "../history.js";
import type { Embedder } from "../embedder.js";
import { expandHome } from "../home-path.js";
import { exportPortable, type PortableExport } from "../memory-portability.js";
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
  /**
   * Which assistant, app or agent WROTE this fact, as the connection announced
   * itself — null when the host knew nothing. Memory "shared across their
   * assistants" is a claim about receipts, and until 0.4.2 recall carried none.
   */
  origin: Origin | null;
  /** Which assistant RETIRED it (invalidate or unpin). Null while it is current. */
  retiredBy: Origin | null;
}

/** A current fact the newly-remembered one might be correcting. A suggestion; nothing acts on it. */
export interface ConflictCandidate {
  id: string;
  text: string;
  validFrom: string;
}

/** What `remember` returns: the stored fact, plus what it might replace. */
export interface RememberedFact extends GovernedFact {
  /**
   * Current facts that read like the new one — the client's cue to call
   * `invalidate` on any that stopped being true. Empty when nothing resembles it.
   */
  mayConflictWith: ConflictCandidate[];
}

/** How many candidates `remember` offers. Three is a glance, not a page to read. */
export const CONFLICT_SUGGESTIONS = 3;

/**
 * Wire limits. Both were bare `z.string()`: a 10 MB "fact" was accepted, indexed,
 * and returned in full on every recall that matched it, and a 10 MB PIN would
 * ride every prompt of every conversation (Fable 5.1 MCP-surface review,
 * 2026-09-19). A durable fact is a plain sentence; a standing rule is shorter
 * still — and the whole pinned tier only gets DEFAULT_PINNED_BUDGET characters
 * of prompt anyway, so a pin bigger than the budget could never be shown.
 * The cap is on the MCP surface, where the caller is a model: a host calling
 * `governanceTools` directly is its own trust boundary.
 */
export const REMEMBER_MAX_CHARS = 4_000;
export const PIN_MAX_CHARS = 500;
/**
 * The rest of the wire, capped for the same reason (review 2026-09-22): a 2 MB
 * `invalidate.reason` was stored in the fact's metadata, copied into every later
 * history version, and served back by `history`. Ids are UUIDs (36 characters);
 * a query is a few keywords.
 */
export const REASON_MAX_CHARS = 500;
export const ID_MAX_CHARS = 128;
export const QUERY_MAX_CHARS = 1_000;

/**
 * What the handshake announces. It was a literal, and the 0.4.2 and 0.4.3 tags
 * both shipped announcing "0.4.1". package.json sits two levels up from both
 * src/mcp and dist/mcp.
 */
export const SERVER_VERSION: string = (JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string }).version;

/**
 * A candidate must score at least this share of the best candidate's relevance.
 *
 * Measured on the governed path against 300 distractors, 2026-09-19: "Lives in
 * Berlin" ranked "Lives in Tokyo" first at 0.2310, then two "The deploy script
 * lives in tools/deploy-N.sh and needs sudo" lines at 0.0578 — a quarter of the
 * top, matching on "lives" alone. Signal sat at 1.00× and that noise at 0.25×,
 * so a half-way cut is nowhere near either. The best candidate is never dropped:
 * the store's ranking decides what is first, this only trims the tail behind it.
 */
const CONFLICT_RELEVANCE_FLOOR = 0.5;

/**
 * "What might this replace?", answered at write time.
 *
 * Invalidate-never-overwrite only works if somebody CALLS invalidate, and
 * nothing in the surface ever prompted it: "I live in Tokyo", later "I moved to
 * Berlin", and both facts stay current with nothing saying they disagree (Fable
 * 5.1 MCP-surface review, 2026-09-19).
 *
 * The search is the ordinary governed keyword path — same ranking, same policy,
 * same audit — over the new fact's own words, with tokens of two characters or
 * fewer dropped. That strip does most of the work: "in", "at", "a", "of" match
 * nearly everything ("Works at Anthropic now" returned two "speaks X at home"
 * facts before the strip and only the old employer after it, measured
 * 2026-09-19). What survives is a suggestion; the client decides, and the store
 * changes nothing.
 *
 * The honest residual, measured the same day: a new fact whose only shared words
 * are common ones can still tie with several unrelated facts — "The garage door
 * opener needs a new battery" offered three deploy-script lines, all matching
 * "the" and "needs", all scoring identically. No lexical rule tested separates
 * that from the true single-common-word hit ("Works at Anthropic now" →
 * "Works at Acme Corp"), so the tie is not filtered, it is labelled: these are
 * facts to READ, not conflicts that were found.
 */
async function mayConflictWith(
  store: MemoryStore,
  text: string,
  excludeId: string,
  atIso: string,
): Promise<ConflictCandidate[]> {
  const tokens = queryTokens(text).filter((t) => t.length > 2);
  if (tokens.length === 0) return [];
  // One extra: the fact just written usually ranks first against its own words.
  const found = (await store.searchNodes({ query: tokens.join(" "), limit: CONFLICT_SUGGESTIONS + 1, validAt: atIso }))
    .filter((n) => n.nodeId !== excludeId)
    .slice(0, CONFLICT_SUGGESTIONS);
  if (found.length === 0) return [];
  // Keep the store's ORDER (its ranking is the authority) and use the scores only
  // as a floor against the best candidate.
  const scores = visibleRelevance(found.map((n) => n.content.text), tokens);
  const best = Math.max(...scores);
  return found
    .filter((_, i) => best <= 0 || scores[i]! >= best * CONFLICT_RELEVANCE_FLOOR)
    .map((n) => ({ id: n.nodeId, text: n.content.text, validFrom: n.validFrom }));
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
    origin: readOrigin(meta),
    retiredBy: readOrigin(meta, "retiredBy"),
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

/**
 * What the server's `export` tool reads: the same owner policy and audience as
 * `serverStore`, judged by beforeExport — so an assistant can export what it
 * could recall and nothing more. The owner's full backup is the CLI's
 * `al-buddy-memory export`.
 */
export function serverExportView(inner: MemoryStore, opts: { owner?: string; audit?: AuditSink } = {}): MemoryStore {
  const owner = opts.owner ?? "owner";
  return exportView(inner, {
    policies: [personalDefaults({ owner })],
    context: () => ({ actor: owner, audience: "mcp-client" }),
    audit: opts.audit,
  });
}

export interface GovernanceDeps {
  store: MemoryStore;
  /** Who is writing, asked at each write. The shipped server answers from the MCP handshake. */
  origin?: () => Origin | undefined;
  /**
   * Turns recall hybrid (keyword + vector). A function is asked at every call,
   * so a server can start on keyword recall and switch once its model has
   * loaded (`startSemanticRecall`); `undefined` from it means keyword for now.
   */
  embedder?: Embedder | (() => Embedder | undefined);
  /** A recall or index through the embedder threw: told once per failure, and the call falls back to keyword. */
  onEmbedderFailure?: (reason: string) => void;
  /**
   * Hybrid recall reads the query for time and counting cues (`RecallOptions.expand`),
   * the setting the LongMemEval result was measured with. Default true; false
   * recalls exactly as 0.9.0 did.
   */
  expand?: boolean;
  /**
   * What the `export` tool reads: give it an `exportView` so the policy's
   * beforeExport decides what leaves. Defaults to `store`.
   */
  exportStore?: MemoryStore;
  /**
   * Let `export` write to a path on this machine. The stdio server, which runs
   * as the user on the user's machine, turns it on; the remote (HTTP) server
   * does not, so a remote client can never write files on the host. Off by default.
   */
  exportToFiles?: boolean;
  /** The project name an export carries (default "default"). */
  exportProject?: string;
  now?: () => Date;
  encryptionKeyRef?: string;
}

/**
 * The largest export the tool returns in its answer. Bigger ones are written to
 * a file the caller names: a whole memory in a tool result is context nobody
 * asked to spend (~50 KB is ~12k tokens).
 */
export const EXPORT_INLINE_MAX_BYTES = 50_000;
export const PATH_MAX_CHARS = 1_024;

/** What `export` returns when it wrote a file. */
export interface ExportWritten {
  path: string;
  bytes: number;
  facts: number;
  edges: number;
  formatVersion: string;
}

/**
 * What every connecting client is told about using this server. Claude Desktop
 * connected five times and never called a tool: a client that is not told when to
 * recall and what to remember does neither (founder, 2026-09-15).
 *
 * All of it fits in 512 characters — measured at 504 with `history` in it — because some clients read
 * only that much. It was 637 until 2026-09-18, which put `invalidate` and `pin`
 * outside the window the claim exists to satisfy; the test asserts the LENGTH
 * now, not a sample of the words, because sampling three of the six rules is
 * what let that ship. Anything added here has to come out of something else.
 */
export const SERVER_INSTRUCTIONS = [
  "This is the user's long-term memory shared across assistants.",
  "At the start of a conversation, or when a person, project, preference or decision comes up, call recall with a few keywords.",
  "Call history with a fact id when its recorded changes matter.",
  "For durable statements, call remember with one plain sentence.",
  "Never remember secrets, small talk or one-off requests.",
  "When a fact stops being true, call invalidate with its id; nothing is deleted.",
  "Use pin only for rules that belong in every conversation.",
].join(" ");

/** The tool implementations, transport-free. */
export function governanceTools(deps: GovernanceDeps) {
  const now = deps.now ?? (() => new Date());
  const pins = new PinnedBlocks(deps.store, { now, ...(deps.encryptionKeyRef && { encryptionKeyRef: deps.encryptionKeyRef }) });
  const embedderNow: () => Embedder | undefined =
    typeof deps.embedder === "function" ? deps.embedder : ((e) => () => e)(deps.embedder);
  // One retriever per embedder: it holds the vector matrix between recalls.
  let retriever: { embedder: Embedder; r: HybridRetriever } | null = null;
  const retrieverNow = (): HybridRetriever | null => {
    const e = embedderNow();
    if (!e) return null;
    if (retriever?.embedder !== e) retriever = { embedder: e, r: new HybridRetriever(deps.store, e) };
    return retriever.r;
  };
  const embedderFailed = (err: unknown) => {
    deps.onEmbedderFailure?.((err instanceof Error ? err.message : String(err)).split("\n")[0]!.slice(0, 300));
  };
  const expand = deps.expand ?? true;
  let pinsDelivered = false;
  return {
    /**
     * The pinned tier, once — the first time a connection recalls anything, and
     * "" every time after.
     *
     * The tier claims to be in EVERY prompt and the shipped product surfaced it
     * nowhere: a seventh tool nobody was told to call, and no room to explain it
     * in a 512-character handshake measured at 507 (Fable 5.1 MCP-surface review,
     * 2026-09-19). Riding the first recall costs nothing: the client is already
     * reading facts, and a client that never recalls never needed the pins.
     *
     * An EMPTY tier does not spend the delivery — a pin made on turn five still
     * rides the next recall, rather than being lost because the store happened to
     * be empty when the connection opened.
     */
    async pinnedPreamble(): Promise<string> {
      if (pinsDelivered) return "";
      const block = await pins.render();
      if (block === "") return "";
      pinsDelivered = true;
      return block;
    },
    async remember(input: { text: string; provenance?: MemoryNode["provenance"] | undefined; memoryType?: MemoryNode["memoryType"] | undefined; confidence?: number | undefined }): Promise<RememberedFact> {
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
      // Embedded now, or vector recall cannot find it until a backfill runs. Only
      // a fact this reader can see: a governed handle refuses to embed one a
      // policy hides (a secret written Sensitive), exactly as for a missing fact,
      // and remembering it must not fail over a cache (review 2026-09-22).
      const r = retrieverNow();
      if (r && (await deps.store.getNode(saved.nodeId))) {
        // The fact is stored; a vector is a cache. A failed embed leaves it
        // keyword-findable, and the next start's backfill embeds it.
        try {
          await r.indexNode(saved);
        } catch (err) {
          embedderFailed(err);
        }
      }
      return { ...toGovernedFact(saved), mayConflictWith: await mayConflictWith(deps.store, text, saved.nodeId, now().toISOString()) };
    },
    /**
     * Valid time goes INTO the read. It used to ask for twice the page and drop
     * the superseded facts afterwards, so a subject the person had corrected
     * often enough came back empty: sixteen retired facts outranked the one
     * still true, filled the candidate list, and left nothing (Astra R7,
     * reproduced in both stores, 2026-09-18). Oversampling cannot make a full
     * page of current facts; a filter the store applies can.
     */
    async recall(input: { query: string; limit?: number | undefined; includeSuperseded?: boolean | undefined }): Promise<GovernedFact[]> {
      const limit = Math.max(1, Math.min(50, input.limit ?? 8));
      const currentOnly = input.includeSuperseded !== true ? { validAt: now().toISOString() } : {};
      // With an embedder the retriever already reads at an instant, and asking
      // it for history is a known limitation rather than a new one (CHANGELOG).
      const r = retrieverNow();
      if (r) {
        try {
          return (await r.recall(input.query, { limit, ...currentOnly, ...(expand ? { expand: true } : {}) })).map(toGovernedFact);
        } catch (err) {
          // The model failing mid-session must not cost the caller its answer.
          embedderFailed(err);
        }
      }
      return (await deps.store.searchNodes({ query: input.query, limit, ...currentOnly })).map(toGovernedFact);
    },
    async history(input: { id: string }) {
      if (!isHistoryCapable(deps.store)) return [];
      return (await deps.store.history(input.id)).map(({ recordedAt, event, before, after }) => ({ recordedAt, event, before, after }));
    },
    /**
     * Why it believes a fact: who asserted it, when it was true and what ended
     * it, and for a conclusion the exact words it rests on, each checked now
     * (explain.ts). A source this caller may not read is named as withheld.
     */
    async explain(input: { id: string }): Promise<Explanation> {
      const e = await explainFact(deps.store, input.id, { now });
      if (!e) throw new Error(`explain: no fact ${input.id}`);
      return e;
    },
    /**
     * A standing question's pre-written answer, with how fresh it is and the
     * words it rests on — no model call. With no id, every model. Answers are
     * refreshed by the host (refreshMentalModels), not by this call.
     */
    async mentalModel(input: { id?: string | undefined }): Promise<MentalModel | MentalModel[]> {
      if (input.id === undefined || input.id.trim() === "") return listMentalModels(deps.store, { now });
      const m = await getMentalModel(deps.store, input.id, { now });
      if (!m) throw new Error(`mental_model: no mental model ${input.id}`);
      return m;
    },
    /** Define a standing question for the host's next refresh to answer. */
    async defineMentalModel(input: { question: string; tags?: string[] | undefined }): Promise<{ id: string; question: string }> {
      const id = await defineMentalModel(deps.store, { question: input.question, ...(input.tags && input.tags.length > 0 ? { scope: { tags: input.tags } } : {}) });
      return { id, question: input.question.replace(/\s+/g, " ").trim() };
    },
    /** Close a fact's validity. Never deletes; optionally names the replacement. */
    async invalidate(input: { id: string; replacedBy?: string | undefined; reason?: string | undefined }): Promise<GovernedFact> {
      const node = await deps.store.getNode(input.id);
      if (!node) throw new Error(`invalidate: no fact ${input.id}`);
      if (node.validTo !== null) return toGovernedFact(node);
      // A successor is a claim about another fact, so it has to be one this
      // caller can see — not a typo, and not the fact itself (review 2026-09-22).
      if (input.replacedBy !== undefined) {
        if (input.replacedBy === input.id) throw new Error("invalidate: replacedBy cannot be the fact being invalidated");
        if (!(await deps.store.getNode(input.replacedBy))) throw new Error(`invalidate: replacedBy names no fact: ${input.replacedBy}`);
      }
      const at = now().toISOString();
      // `origin` stays as written — who wrote a fact never changes. Who RETIRED it
      // is a second, separate receipt.
      const retiredBy = knownOrigin(deps.origin?.());
      const updated = await deps.store.updateNode(input.id, {
        validTo: at,
        contextualMetadata: { ...node.contextualMetadata, ...(input.replacedBy && { supersededBy: input.replacedBy }), ...(input.reason && { invalidatedBecause: input.reason }), ...(retiredBy && { retiredBy }), invalidatedAt: at },
      });
      return toGovernedFact(updated);
    },
    async pin(input: { text: string; label?: string | undefined }) {
      // Refused before anything is written. The shipped store classifies text
      // that reads like a secret as Sensitive, which hides it from this very
      // assistant: the pin would never render, and each retry would add another
      // hidden copy. PinnedBlocks catches any other policy that hides a pin,
      // after the write; this catches the common case before it (review 2026-09-22).
      if (looksSecret(input.text)) {
        throw new Error("pin: this reads like a secret (for example \"pin is …\" or \"password: …\"), so it would be stored Sensitive and hidden from assistants — it would never appear in the pinned tier. Reword it without the secret-like phrase, or leave secrets out of memory.");
      }
      const origin = deps.origin?.();
      return pins.pin({ text: input.text, ...(input.label && { label: input.label }), ...(origin && { origin }) });
    },
    async unpin(input: { id: string }) {
      const origin = deps.origin?.();
      return { unpinned: await pins.unpin(input.id, origin) };
    },
    async pinned() {
      return { blocks: await pins.list(), rendered: await pins.render() };
    },
    /**
     * The memory in the documented portable format (docs/portable-format.schema.json),
     * as the policy lets it leave: through an exportView, beforeExport decides,
     * so an assistant cannot carry out what it could not recall. Small exports
     * come back in the answer; bigger ones need a path, which must be absolute,
     * end in .json, and not exist yet — this never overwrites a file.
     */
    async export(input: { path?: string | undefined }): Promise<PortableExport | ExportWritten> {
      const project = deps.exportProject ?? "default";
      const artifact = await exportPortable(new Map([[project, deps.exportStore ?? deps.store]]));
      const text = JSON.stringify(artifact, null, 2);
      const bytes = Buffer.byteLength(text, "utf8");
      const raw = input.path?.trim();
      if (!raw) {
        if (bytes > EXPORT_INLINE_MAX_BYTES) {
          throw new Error(`export: the export is ${bytes} bytes, more than the ${EXPORT_INLINE_MAX_BYTES} returned inline. Give a path (an absolute path ending in .json that does not exist yet) to write it to.`);
        }
        return artifact;
      }
      if (!deps.exportToFiles) throw new Error("export: this server does not write files; call export without a path (it returns the export when it is small enough)");
      const path = expandHome(raw);
      if (!isAbsolute(path)) throw new Error(`export: the path must be absolute (got ${raw})`);
      if (!path.toLowerCase().endsWith(".json")) throw new Error("export: the path must end in .json");
      try {
        // "wx": fail if the file exists — an export never replaces anything.
        writeFileSync(path, text + "\n", { flag: "wx", mode: 0o600 });
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "EEXIST") throw new Error(`export: ${path} already exists; name a new file`);
        if (code === "ENOENT") throw new Error(`export: the folder for ${path} does not exist`);
        throw err;
      }
      const facts = artifact.projects.reduce((n, p) => n + p.nodes.length, 0);
      const edges = artifact.projects.reduce((n, p) => n + p.edges.length, 0);
      return { path, bytes: bytes + 1, facts, edges, formatVersion: artifact.formatVersion };
    },
  };
}

/**
 * What each tool does to the store, as both assistant directories ask every
 * tool to declare (Claude: a title plus readOnlyHint or destructiveHint;
 * ChatGPT: all three hints). "Destructive" is read strictly: nothing here
 * deletes, but closing a fact's validity changes what recall returns.
 */
export const TOOL_ANNOTATIONS = {
  remember: { title: "Remember a fact", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  recall: { title: "Recall facts", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  history: { title: "Fact history", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  explain: { title: "Explain a fact", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  mental_model: { title: "Read a mental model", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  define_mental_model: { title: "Define a mental model", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  invalidate: { title: "Retire a fact", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  pin: { title: "Pin a rule", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  unpin: { title: "Unpin a rule", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  pinned: { title: "List pinned rules", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  // Not read-only: with a path it writes a new file (never an existing one).
  export: { title: "Export memory", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
} as const;

/** Wire the tools onto an MCP server instance (stdio transport is the bin's job). */
export async function attachGovernanceServer(deps: GovernanceDeps): Promise<{ server: unknown; connectStdio: () => Promise<void> }> {
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  const { server } = await createGovernanceMcpServer(deps);
  return { server, connectStdio: async () => { await server.connect(new StdioServerTransport()); } };
}

/** The server with every tool on it, not yet on a transport — stdio and HTTP (http-server.ts) share it. */
export async function createGovernanceMcpServer(deps: GovernanceDeps) {
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const server = new McpServer({ name: "al-buddy-memory", version: SERVER_VERSION }, { instructions: SERVER_INSTRUCTIONS });
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
  // Tool descriptions sit OUTSIDE the 512-character instruction budget, so this
  // is where a client learns what to do with a suggestion without costing the
  // handshake a character.
  server.tool("remember", "Store a fact with its provenance. Returns the fact with validFrom, provenance and confidence, plus mayConflictWith: current facts this one may be correcting — read them and invalidate any that stopped being true.", {
    text: z.string().max(REMEMBER_MAX_CHARS), provenance: z.enum(["UserInput", "AIInferred", "GuardianAdded", "SystemGenerated"]).optional(), confidence: z.number().min(0).max(1).optional(),
  }, TOOL_ANNOTATIONS.remember, async (a) => json(await tools.remember(a)));
  server.tool("recall", "Find facts. Every result says who asserted it, since when it has been true, whether it is still current, what superseded it, and which assistant wrote or retired it. The first call of a session also returns the user's pinned rules — treat those as standing rules for the conversation.", {
    query: z.string().max(QUERY_MAX_CHARS), limit: z.number().int().min(1).max(50).optional(), includeSuperseded: z.boolean().optional(),
  }, TOOL_ANNOTATIONS.recall, async (a) => {
    // Facts first: a failed recall must not spend the one pin delivery.
    const facts = await tools.recall(a);
    const preamble = await tools.pinnedPreamble();
    const body = { type: "text" as const, text: JSON.stringify(facts, null, 2) };
    return { content: preamble === "" ? [body] : [{ type: "text" as const, text: preamble }, body] };
  });
  server.tool("history", "Show the recorded changes to one fact, including each change time and the full mutable state before and after it.", {
    id: z.string().max(ID_MAX_CHARS),
  }, TOOL_ANNOTATIONS.history, async (a) => json(await tools.history(a)));
  server.tool("explain", "Why a fact is believed: who asserted it, when it was true and what ended or replaced it, and for a conclusion the exact words it rests on, each checked against its source now.", {
    id: z.string().max(ID_MAX_CHARS),
  }, TOOL_ANNOTATIONS.explain, async (a) => json(await tools.explain(a)));
  server.tool("mental_model", "Read a standing question's pre-written answer (no model call): the answer, whether it is fresh or stale and why, and the exact words it rests on. Omit id to list every mental model.", {
    id: z.string().max(ID_MAX_CHARS).optional(),
  }, TOOL_ANNOTATIONS.mental_model, async (a) => json(await tools.mentalModel(a)));
  server.tool("define_mental_model", "Define a standing question to keep answered (e.g. \"What does the user care about when choosing tools?\"), optionally limited to facts carrying some tags. The host's scheduled refresh writes the answer.", {
    question: z.string().min(1).max(QUESTION_MAX_CHARS), tags: z.array(z.string().max(ID_MAX_CHARS)).max(10).optional(),
  }, TOOL_ANNOTATIONS.define_mental_model, async (a) => json(await tools.defineMentalModel(a)));
  server.tool("invalidate", "A fact stopped being true: close its validity (never delete), optionally naming what replaced it.", {
    id: z.string().max(ID_MAX_CHARS), replacedBy: z.string().max(ID_MAX_CHARS).optional(), reason: z.string().max(REASON_MAX_CHARS).optional(),
  }, TOOL_ANNOTATIONS.invalidate, async (a) => json(await tools.invalidate(a)));
  server.tool("pin", "Pin a fact into the always-in-prompt tier. Only rules that belong in every conversation; it is a small, budgeted tier.", { text: z.string().max(PIN_MAX_CHARS), label: z.string().max(40).optional() }, TOOL_ANNOTATIONS.pin, async (a) => json(await tools.pin(a)));
  server.tool("unpin", "Unpin a fact (its validity closes; it is kept).", { id: z.string().max(ID_MAX_CHARS) }, TOOL_ANNOTATIONS.unpin, async (a) => json(await tools.unpin(a)));
  server.tool("pinned", "The pinned tier, as a list and as the rendered prompt block.", {}, TOOL_ANNOTATIONS.pinned, async () => json(await tools.pinned()));
  server.tool("export", `Export the user's memory in the portable format, with provenance and validity. Only when the user asks for an export or backup. Without a path it is returned inline if under ${EXPORT_INLINE_MAX_BYTES} bytes; otherwise give an absolute path ending in .json that does not exist yet (never overwrites).`, {
    path: z.string().max(PATH_MAX_CHARS).optional(),
  }, TOOL_ANNOTATIONS.export, async (a) => json(await tools.export(a)));
  return { server };
}

export { startSemanticRecall, DEFAULT_INDEX_LIMIT } from "./semantic.js";
export type { SemanticRecall, SemanticStatus, SemanticOptions } from "./semantic.js";
