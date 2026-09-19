import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { MemoryNode, MemoryNodeType, NewMemoryNode } from "./types/memory.js";

import { SqliteMemoryStore, readRecordedScope } from "./sqlite-memory-store.js";
import { renderMemoryBlock } from "./memory-block.js";
import type { BlockScope } from "./memory-block.js";
import { exportMemoryMarkdown } from "./memory-export.js";

/**
 * Per-project memory — a thin, siloed layer over {@link SqliteMemoryStore}.
 *
 * Each project (one Telegram channel / one coding-agent context) gets its own
 * database file, so projects never bleed into each other. This is the unit the
 * build-companion loop reads and writes: capture as you talk, recall on demand,
 * and load the "memory block" digest at session start.
 */

export interface CaptureInput {
  text: string;
  /** Node type. Defaults to "Conversation" (a captured turn). */
  type?: MemoryNodeType;
  tags?: string[];
  provenance?: NewMemoryNode["provenance"];
  /** Ranking weight [0..1]; higher surfaces first in the block. Default 1.0. */
  confidenceWeight?: number;
  /** Self-verification: a READ-ONLY shell command that re-checks this fact against
   *  reality, plus an optional regex the output must match (else the exit code is
   *  used). `memory verify` re-runs these to catch when a fact has gone stale —
   *  deterministic, zero LLM tokens. Store ONLY trusted read-only commands. */
  verify?: { command: string; expect?: string };
}

export interface ProjectMemoryOptions {
  /** Directory that holds the per-project DB files. Default `~/.al-buddy/memory`. */
  baseDir?: string;
}

/** Default directory for per-project memory databases. */
export const DEFAULT_MEMORY_DIR = join(homedir(), ".al-buddy", "memory");

/**
 * A readable, filename-safe stub of a project name. Lossy on purpose — it is
 * for the human reading `ls`, and the digest beside it is what identifies the
 * scope. `.` stays out of the allowed set so no name can introduce a `..`
 * path-traversal segment, and a leading `-` is trimmed so no filename can be
 * mistaken for a command-line flag.
 */
function slug(project: string): string {
  const safe = project.replace(/[^a-zA-Z0-9_-]/g, "-").replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  return safe.replace(/-+$/, "") || "project";
}

/** 64 bits of SHA-256 over the whole scope — what makes the filename injective. */
function scopeDigest(project: string): string {
  return createHash("sha256").update(project, "utf8").digest("hex").slice(0, 16);
}

/**
 * The filename a scope gets from 0.4.2 on: a readable stub, then a digest of the
 * full name. Two scopes share a file only if they share a SHA-256 prefix, where
 * before they shared one whenever they sanitised alike — "org/repo" and
 * "org-repo" both became `org-repo.db`, and each recalled the other's private
 * facts (R1, release review 2026-09-18).
 *
 * The separator is a dot, and that is load-bearing. It was a dash, which meant a
 * canonical name was a name the OLD scheme could also produce (its output was
 * `<anything over [A-Za-z0-9_-]>.db`): a 0.4.1 project called literally
 * `foo-2c26b46b68ffc68f` owned the file that `foo`'s canonical path pointed at,
 * so `foo` claimed a stranger's database and read its private facts while the
 * owner was sent to an empty store (GPT-6-Astra on the merged result,
 * 2026-09-19). `slug` strips every dot, so a canonical stem always holds a
 * character the old scheme could not leave behind — the two namespaces cannot
 * meet, rather than being checked for meeting.
 */
export function canonicalProjectDbPath(project: string, baseDir: string = DEFAULT_MEMORY_DIR): string {
  return join(baseDir, `${slug(project)}.${scopeDigest(project)}.db`);
}

/** The filename 0.4.1 and earlier used: the sanitised name alone, collisions and all. */
export function legacyProjectDbPath(project: string, baseDir: string = DEFAULT_MEMORY_DIR): string {
  return join(baseDir, `${project.replace(/[^a-zA-Z0-9_-]/g, "-")}.db`);
}

/**
 * Where this project's memory actually lives — the canonical path, unless a
 * store written under the old scheme is already there and is this project's.
 *
 * Existing data is never stranded and never moved: a file from 0.4.1 records no
 * scope, so the first project to open it claims it and stamps its name inside
 * (see `SqliteMemoryStore`'s `scope` option). Where two names used to collide,
 * the claimant keeps the old file and the other gets a fresh canonical one —
 * whichever opens first, then stably from then on. That is the one case where
 * facts a scope used to see move out of its reach; they are not deleted, they
 * are in the other scope's file, and a mixed store cannot be split by machine.
 *
 * Order of preference, and every step of it is "is this file MINE?": a
 * canonical file stamped with this scope; then this scope's own 0.4.1 file, if
 * it is unstamped or stamped with this scope; then the canonical path. The
 * first clause used to be "a canonical file, full stop", which handed this
 * scope any database that happened to sit at that path (2026-09-19). The
 * filename schemes can no longer overlap, so that is now belt as well as
 * braces — and a canonical file stamped by somebody else still reaches
 * `claimScope`, which refuses it rather than merging.
 */
export function projectDbPath(project: string, baseDir: string = DEFAULT_MEMORY_DIR): string {
  const canonical = canonicalProjectDbPath(project, baseDir);
  if (existsSync(canonical) && readRecordedScope(canonical) === project) return canonical;
  const legacy = legacyProjectDbPath(project, baseDir);
  if (legacy === canonical || !existsSync(legacy)) return canonical;
  const claimed = readRecordedScope(legacy);
  return claimed === null || claimed === project ? legacy : canonical;
}

export class ProjectMemory {
  readonly project: string;
  /** The file this project's facts are in — resolved once, at construction. */
  readonly dbPath: string;
  private readonly store: SqliteMemoryStore;

  constructor(project: string, options: ProjectMemoryOptions = {}) {
    this.project = project;
    this.dbPath = projectDbPath(project, options.baseDir);
    // The scope goes inside the file as well as into its name: a filename is a
    // label, and a store opened under the wrong project must fail, not merge.
    this.store = new SqliteMemoryStore(this.dbPath, { scope: project });
  }

  /** Store a new memory. Raw text is preserved verbatim — never summarized away. */
  async capture(input: CaptureInput): Promise<MemoryNode> {
    const contextualMetadata: Record<string, unknown> = {};
    if (input.tags && input.tags.length > 0) contextualMetadata["tags"] = input.tags;
    if (input.verify) contextualMetadata["verify"] = input.verify;
    return this.store.addNode({
      provenance: input.provenance ?? "UserInput",
      encryptionKeyRef: "local", // MVP: key management is TBD (schema §Phase 1).
      memoryType: input.type ?? "Conversation",
      privacyClassification: "Private",
      retentionTier: "FullRetention",
      content: { text: input.text },
      contextualMetadata,
      confidenceWeight: input.confidenceWeight ?? 1.0,
      decayRate: 0.0,
    });
  }

  /** Full-text recall across this project's memories. */
  async recall(query: string, limit = 10): Promise<MemoryNode[]> {
    return this.store.searchNodes({ query, limit });
  }

  /** Currently-valid memories (validAt=now), ranked — for iterating, e.g. to
   *  re-run self-verification checks. */
  async validNodes(at: string = new Date().toISOString(), limit = 50): Promise<MemoryNode[]> {
    return this.store.searchNodes({ validAt: at, limit });
  }

  /**
   * Invalidate a fact as of now (bi-temporal): it stops being current but is
   * NOT deleted, so history is preserved. Superseded facts drop out of the block.
   */
  /** Clear the untrusted-sources tag a curated fact carries (review 2026-09-01,
   *  S2) so it re-enters the memory block. Confidence returns to inferred. */
  async confirm(nodeId: string): Promise<{ node: MemoryNode; wasTaggedFrom: string[] }> {
    const node = await this.store.getNode(nodeId);
    if (!node) throw new Error(`no memory with id ${nodeId}`);
    const { untrustedSources, ...rest } = node.contextualMetadata as Record<string, unknown>;
    const from = Array.isArray(untrustedSources) ? untrustedSources.map(String) : [];
    if (from.length === 0) return { node, wasTaggedFrom: [] };
    const updated = await this.store.updateNode(nodeId, {
      contextualMetadata: rest,
      confidenceWeight: Math.max(node.confidenceWeight, 0.8),
    });
    return { node: updated, wasTaggedFrom: from };
  }

  async supersede(nodeId: string, at: string = new Date().toISOString()): Promise<MemoryNode> {
    return this.store.updateNode(nodeId, { validTo: at });
  }

  /**
   * Render the per-project "memory block" — the dense digest injected into the
   * agent's context at session start. Currently-valid memories only, ranked by
   * confidence, grouped by type. The full archive stays searchable via recall().
   */
  async renderBlock(limit = 30, scope: BlockScope = {}): Promise<string> {
    return renderMemoryBlock(this.store, this.project, limit, scope);
  }

  /** Render a read-only, human-readable Markdown mirror of this project's memory. */
  async exportMarkdown(): Promise<string> {
    return exportMemoryMarkdown(this.store, this.project);
  }

  close(): void {
    this.store.close();
  }
}
