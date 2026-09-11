import { homedir } from "node:os";
import { join } from "node:path";

import type { MemoryNode, MemoryNodeType, NewMemoryNode } from "./types/memory.js";

import { SqliteMemoryStore } from "./sqlite-memory-store.js";
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

/** Resolve the database path for a project, sanitizing the name into a filename. */
export function projectDbPath(project: string, baseDir: string = DEFAULT_MEMORY_DIR): string {
  // Drop `.` from the allowed set so a project name can never introduce a `..`
  // path-traversal segment into the filename.
  const safe = project.replace(/[^a-zA-Z0-9_-]/g, "-");
  return join(baseDir, `${safe}.db`);
}

export class ProjectMemory {
  readonly project: string;
  private readonly store: SqliteMemoryStore;

  constructor(project: string, options: ProjectMemoryOptions = {}) {
    this.project = project;
    this.store = new SqliteMemoryStore(projectDbPath(project, options.baseDir));
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
