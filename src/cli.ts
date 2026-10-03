/**
 * The command-line jobs behind `al-buddy-memory export | import | context`,
 * as plain functions so they test without a process. The bin parses flags and
 * prints; everything that decides anything is here.
 *
 * All three open the same database the MCP server uses and go through the same
 * owner policy (`personalDefaults`), with the same audit trail in the database:
 *
 * - `export` is the OWNER's backup: every fact, Sensitive and Sealed included,
 *   because the person at the terminal is the owner. (The MCP `export` tool is
 *   the assistant's, and the policy keeps what it may not see out of it.)
 * - `import` restores a portable export verbatim, as the owner.
 * - `context` is what an assistant is shown at session start, so it reads with
 *   the assistant as the audience: what recall would hide, it hides.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

import { compareRecency } from "./decay.js";
import { exportView, govern } from "./governance/governed-store.js";
import { personalDefaults } from "./governance/samples.js";
import { storeAudit } from "./governance/audit.js";
import { expandHome } from "./home-path.js";
import { exportMemoryMarkdown } from "./memory-export.js";
import { exportPortable, importPortable, type ImportSummary, type PortableExport } from "./memory-portability.js";
import { isMentalModelNode } from "./mental-models.js";
import { PinnedBlocks, PINNED_TAG } from "./pinned.js";
import { SqliteMemoryStore } from "./sqlite-memory-store.js";
import type { MemoryNode } from "./types/memory.js";

/** Where the MCP server keeps memory, unless AL_BUDDY_MEMORY_DB says otherwise. */
export function memoryDbPath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env["AL_BUDDY_MEMORY_DB"]?.trim();
  return expandHome(configured ? configured : join(homedir(), ".al-buddy-memory", "brain.db"));
}

export type ExportFormat = "portable" | "markdown";

export interface CliStoreOptions {
  db: string;
  owner?: string;
}

function open(db: string): SqliteMemoryStore {
  return new SqliteMemoryStore(db, process.env["AL_BUDDY_MEMORY_AUDIT_KEY"] ? { auditKey: process.env["AL_BUDDY_MEMORY_AUDIT_KEY"] } : {});
}

/** The owner's export of a database: the portable JSON (lossless) or a read-only Markdown mirror. */
export async function exportMemory(opts: CliStoreOptions & { format?: ExportFormat; project?: string }): Promise<string> {
  if (!existsSync(opts.db)) throw new Error(`no memory at ${opts.db} (set AL_BUDDY_MEMORY_DB or pass --db)`);
  const inner = open(opts.db);
  try {
    const owner = opts.owner ?? "owner";
    const view = exportView(inner, { policies: [personalDefaults({ owner })], context: () => ({ actor: owner }), audit: storeAudit(inner) });
    const project = opts.project ?? "default";
    if ((opts.format ?? "portable") === "markdown") return await exportMemoryMarkdown(view, project);
    return JSON.stringify(await exportPortable(new Map([[project, view]])), null, 2) + "\n";
  } finally {
    inner.close();
  }
}

/** Write an export to a NEW file (never overwrites), owner-readable only. */
export function writeNewFile(path: string, text: string): void {
  try {
    writeFileSync(path, text, { flag: "wx", mode: 0o600 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`${path} already exists; name a new file`);
    throw err;
  }
}

/**
 * Restore a portable export into the database, as the owner. Every check runs
 * on the whole artifact before anything is written; running it again is safe.
 */
export async function importMemory(opts: CliStoreOptions & { file: string }): Promise<ImportSummary> {
  const artifact = JSON.parse(readFileSync(opts.file, "utf8")) as PortableExport;
  const inner = open(opts.db);
  try {
    const owner = opts.owner ?? "owner";
    const store = govern(inner, { policies: [personalDefaults({ owner })], context: () => ({ actor: owner }), audit: storeAudit(inner) });
    return await importPortable(artifact, () => store);
  } finally {
    inner.close();
  }
}

/** Upper bound on what `context` prints, whatever is asked for: a hook's context is capped at 10,000 characters. */
export const CONTEXT_MAX_CHARS = 8_000;
export const CONTEXT_DEFAULT_CHARS = 2_000;
const FACT_LINE_CHARS = 220;
const FACTS_PER_SECTION = 6;

/**
 * A short, bounded briefing for the start of a session: the pinned rules, the
 * current facts that mention the project (the working directory's name), and
 * the most recently learned ones. Empty when there is no memory yet — it never
 * creates the database.
 */
export async function sessionContext(opts: CliStoreOptions & { cwd?: string; maxChars?: number; now?: Date }): Promise<string> {
  if (!existsSync(opts.db)) return "";
  const budget = Math.max(200, Math.min(CONTEXT_MAX_CHARS, Math.floor(opts.maxChars ?? CONTEXT_DEFAULT_CHARS)));
  const now = opts.now ?? new Date();
  const inner = open(opts.db);
  try {
    const owner = opts.owner ?? "owner";
    // The assistant is the audience, exactly as for the MCP server's recall.
    const store = govern(inner, { policies: [personalDefaults({ owner })], context: () => ({ actor: owner, audience: "mcp-client" }), audit: storeAudit(inner) });
    const validAt = now.toISOString();
    const isPlainFact = (n: MemoryNode) => {
      const tags = n.contextualMetadata["tags"];
      return !(Array.isArray(tags) && tags.includes(PINNED_TAG)) && !isMentalModelNode(n);
    };
    const current = (await store.searchNodes({ validAt })).filter(isPlainFact);
    if (current.length === 0) {
      const pins = await new PinnedBlocks(store, { now: () => now }).render();
      if (pins === "") return "";
    }
    const project = opts.cwd ? basename(opts.cwd).trim() : "";
    const aboutProject = project.length > 1 ? (await store.searchNodes({ query: project, validAt, limit: FACTS_PER_SECTION })).filter(isPlainFact) : [];
    const shown = new Set(aboutProject.map((n) => n.nodeId));
    const recent = [...current].sort(compareRecency).filter((n) => !shown.has(n.nodeId)).slice(0, FACTS_PER_SECTION);
    const pins = await new PinnedBlocks(store, { now: () => now }).render();

    const line = (n: MemoryNode) => {
      const text = n.content.text.replace(/\s+/g, " ").trim();
      const cut = text.length > FACT_LINE_CHARS ? `${text.slice(0, FACT_LINE_CHARS - 1)}…` : text;
      return `- ${cut} (since ${n.validFrom.slice(0, 10)}, id ${n.nodeId})`;
    };
    const parts: string[] = [
      `Long-term memory (al-buddy-memory): ${current.length} current fact${current.length === 1 ? "" : "s"}. This is a starting point, not everything — call the recall tool before answering about past work, people, preferences or decisions.`,
    ];
    if (pins !== "") parts.push(pins);
    if (aboutProject.length > 0) parts.push(`Facts mentioning "${project}":\n${aboutProject.map(line).join("\n")}`);
    if (recent.length > 0) parts.push(`Most recently learned:\n${recent.map(line).join("\n")}`);

    // Whole sections first, then whole lines: the cut never lands mid-fact.
    let out = "";
    for (const part of parts) {
      const next = out === "" ? part : `${out}\n\n${part}`;
      if (next.length <= budget) {
        out = next;
        continue;
      }
      for (const l of part.split("\n")) {
        const more = out === "" ? l : `${out}\n${l}`;
        if (more.length > budget) break;
        out = more;
      }
      break;
    }
    return out;
  } finally {
    inner.close();
  }
}
