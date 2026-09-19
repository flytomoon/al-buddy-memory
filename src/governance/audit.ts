/**
 * The audit trail: an append-only record of every governed decision. Who
 * wrote, who read what, what was refused and by which policy. The sink is
 * pluggable; the in-memory one is for tests and single sessions, the JSONL
 * one for a file that survives the process.
 */
import { dirname, join } from "node:path";

import type { Purpose } from "./policy.js";

export interface AuditEvent {
  at: string;
  actor: string;
  audience?: string | undefined;
  purpose: Purpose;
  outcome: "allowed" | "denied" | "hidden";
  /** Facts touched (capped — the count is exact, the ids are a sample). */
  nodeIds: string[];
  count: number;
  policy?: string | undefined;
  reason?: string | undefined;
}

export interface AuditSink {
  record(event: AuditEvent): void | Promise<void>;
}

export const AUDIT_ID_SAMPLE = 20;

export class MemoryAudit implements AuditSink {
  readonly events: AuditEvent[] = [];
  record(event: AuditEvent): void {
    this.events.push(event);
  }
}

/** Append-only JSON lines. One event per line; nothing is ever rewritten. */
export class JsonlAudit implements AuditSink {
  constructor(private readonly path: string) {}
  async record(event: AuditEvent): Promise<void> {
    const { appendFile } = await import("node:fs/promises");
    // Owner-only, like the database it describes: the trail names actors and fact ids.
    await appendFile(this.path, JSON.stringify(event) + "\n", { encoding: "utf8", mode: 0o600 });
  }
}

// ---------------------------------------------------------------------------
// The chained log — tamper-evident, and honest about what that means
// ---------------------------------------------------------------------------

const GENESIS = "0".repeat(64);

/** What a JSON line will hold, with keys sorted so the hash does not depend on key order. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, (v as Record<string, unknown>)[k]]))
      : v,
  );
}

async function digest(prev: string, event: unknown, key: string | undefined): Promise<string> {
  const { createHash, createHmac } = await import("node:crypto");
  const body = `${prev}\n${canonical(event)}`;
  return (key === undefined ? createHash("sha256") : createHmac("sha256", key)).update(body).digest("hex");
}

/**
 * Append-only JSON lines where every line carries the hash of the line before
 * it (`prev`) and of itself (`hash`). Editing, removing, inserting or
 * reordering any line breaks the chain at that line, and verifyAuditChain names
 * it. With a `key` (HMAC-SHA256) the chain cannot be recomputed by someone who
 * does not hold the key — keep it somewhere other than beside the log.
 *
 * What a file cannot prove about itself: that its tail was not cut off, or that
 * a key holder did not rewrite it. For that, publish `head()` somewhere the
 * log's owner does not control (a git commit, a transparency log) and verify
 * against it.
 *
 * ONE WRITER PER FILE. Two processes appending fork the chain, and then neither
 * can start, because refusing to extend a broken chain is what this class does
 * (B1, release review 2026-09-18). Give each writer its own file —
 * {@link auditLogPath} names one per process — and verify the set with
 * {@link verifyAuditLogs}.
 */
export class ChainedAudit implements AuditSink {
  // A true private field: JSON.stringify and util.inspect printed the key when it
  // was an ordinary property (Fable final review, 2026-09-15).
  readonly #key: string | undefined;
  readonly #append: (path: string, data: string) => Promise<void>;
  #tail: Promise<string> | null = null;

  constructor(
    private readonly path: string,
    opts: { key?: string; /** For tests: the write itself. */ append?: (path: string, data: string) => Promise<void> } = {},
  ) {
    this.#key = opts.key;
    this.#append =
      opts.append ??
      (async (file, data) => {
        const { appendFile, mkdir } = await import("node:fs/promises");
        // The per-writer layout puts logs in a directory beside the database;
        // it does not exist until the first event. 0700 like the data dir: the
        // trail names actors and fact ids.
        await mkdir(dirname(file), { recursive: true, mode: 0o700 });
        await appendFile(file, data, { encoding: "utf8", mode: 0o600 });
      });
  }

  /**
   * The head the next line will chain from — but only once the whole existing log
   * verifies under THIS key and ends cleanly. It used to trust the last line: opened
   * with the wrong key it kept appending, a final record without its newline merged
   * with the next, and an unreadable file counted as a new log (Astra final review,
   * 2026-09-15). Verifying costs one read of the file at start.
   */
  private async readHead(): Promise<string> {
    const { readFile } = await import("node:fs/promises");
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (err) {
      if ((err as { code?: string }).code === "ENOENT") return GENESIS;
      throw new Error(`${this.path}: cannot read the audit log (${(err as Error).message}); refusing to start a new chain over it`);
    }
    if (text === "") return GENESIS;
    if (!text.endsWith("\n")) {
      throw new Error(`${this.path}: the last line is incomplete (no final newline), so the chain cannot be extended; remove that line (verify-audit names it) and restart`);
    }
    const result = await verifyChainText(text, this.#key === undefined ? {} : { key: this.#key });
    if (!result.ok) {
      throw new Error(`${this.path} does not verify${this.#key === undefined ? "" : " with this key"} (${result.reason}); refusing to extend it — check it with verify-audit`);
    }
    return result.head;
  }

  /** Keep a promise we hold from ever surfacing as an unhandled rejection; callers still see it reject. */
  #hold(p: Promise<string>): Promise<string> {
    p.catch(() => undefined);
    this.#tail = p;
    return p;
  }

  /** The hash of the newest line — the value to anchor elsewhere. Rejects if the log cannot be extended. */
  head(): Promise<string> {
    return this.#tail ?? this.#hold(this.readHead());
  }

  record(event: AuditEvent): Promise<void> {
    const base = this.head();
    let torn: Error | null = null;
    // Appends are serialised in order, so concurrent calls still form one chain.
    const next = base.then(async (prev) => {
      const plain = JSON.parse(JSON.stringify(event)) as AuditEvent;
      const hash = await digest(prev, plain, this.#key);
      try {
        await this.#append(this.path, JSON.stringify({ prev, hash, event: plain }) + "\n");
      } catch (err) {
        // A failed append may have written part of the line. Nothing more is written
        // until the log is checked: continuing would chain on top of a fragment
        // (Astra final review, 2026-09-15). A restart re-verifies and refuses a torn log.
        torn = new Error(`${this.path}: an append failed part-way (${(err as Error).message}); no more events are written until the log is checked with verify-audit and the process restarts`);
        throw err;
      }
      return hash;
    });
    this.#hold(
      next.catch(() => {
        if (torn) throw torn;
        return base;
      }),
    );
    return next.then(() => undefined);
  }
}

/**
 * Where one process's chained log belongs: `<db>.audit/<start>-<pid>.jsonl`.
 *
 * A chain has exactly one writer, and a person can legitimately run two
 * assistants against one memory — the MCP server's own instructions say the
 * memory is shared across them. So the log is split by writer rather than the
 * second writer being locked out: each process's chain stands on its own, and
 * `verifyAuditLogs` takes the directory. The start time is in the name so the
 * files sort into the order they were opened; the pid separates two processes
 * that started in the same millisecond. Colons become dashes — ISO time is not
 * a filename on every filesystem.
 */
export function auditLogPath(dbPath: string, opts: { at?: Date; pid?: number } = {}): string {
  const at = (opts.at ?? new Date()).toISOString().replace(/:/g, "-");
  return join(`${dbPath}.audit`, `${at}-${opts.pid ?? process.pid}.jsonl`);
}

export type AuditChainResult =
  | { ok: true; count: number; head: string }
  | { ok: false; count: number; line: number; reason: string };

export interface AuditLogsResult {
  ok: boolean;
  logs: { file: string; result: AuditChainResult }[];
  /** Why there was nothing to check, or why the request could not be answered. */
  reason?: string;
}

/**
 * Check one chained log, or every log a directory of them holds — what
 * `al-buddy-memory verify-audit` calls. Each file is verified on its own,
 * because each is one writer's chain; the set is intact when all of them are.
 */
export async function verifyAuditLogs(path: string, opts: { key?: string; head?: string } = {}): Promise<AuditLogsResult> {
  const { readdir, stat } = await import("node:fs/promises");
  let directory = false;
  try {
    directory = (await stat(path)).isDirectory();
  } catch (err) {
    const missing = (err as { code?: string }).code === "ENOENT";
    return { ok: false, logs: [], reason: missing ? `no such file or directory: ${path}` : `cannot read ${path}: ${(err as Error).message}` };
  }
  if (!directory) {
    const result = await verifyAuditChain(path, opts);
    return { ok: result.ok, logs: [{ file: path, result }] };
  }

  // An anchored head belongs to one chain. Saying which one is the caller's job.
  if (opts.head !== undefined) return { ok: false, logs: [], reason: `--head names one log file, not a directory of them: ${path}` };
  const files = (await readdir(path)).filter((f) => f.endsWith(".jsonl")).sort().map((f) => join(path, f));
  if (files.length === 0) return { ok: false, logs: [], reason: `no logs (*.jsonl) in ${path}` };
  const logs = [];
  for (const file of files) logs.push({ file, result: await verifyAuditChain(file, opts) });
  return { ok: logs.every((l) => l.result.ok), logs };
}

/** Check a ChainedAudit file line by line. `head`: the last hash you anchored elsewhere. */
export async function verifyAuditChain(path: string, opts: { key?: string; head?: string } = {}): Promise<AuditChainResult> {
  const { readFile } = await import("node:fs/promises");
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    // A verifier must never call a wrong path "intact: 0 events".
    const missing = (err as { code?: string }).code === "ENOENT";
    return { ok: false, count: 0, line: 0, reason: missing ? `no such file: ${path}` : `cannot read ${path}: ${(err as Error).message}` };
  }
  return verifyChainText(text, opts);
}

async function verifyChainText(text: string, opts: { key?: string; head?: string }): Promise<AuditChainResult> {
  // Line numbers are physical lines of the file, blank ones included, so the number
  // a person is told is the line their editor shows.
  const physical = text.split("\n");
  const count = physical.filter((l) => l.trim() !== "").length;
  let prev = GENESIS;
  for (const [i, line] of physical.entries()) {
    if (line.trim() === "") continue;
    const at = { ok: false as const, count, line: i + 1 };
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return { ...at, reason: `line ${i + 1} is not JSON` };
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ...at, reason: `line ${i + 1} is not a chained audit record` };
    }
    const rec = parsed as { prev?: unknown; hash?: unknown; event?: unknown };
    if (typeof rec.prev !== "string" || typeof rec.hash !== "string" || rec.event === undefined) {
      return { ...at, reason: `line ${i + 1} is not a chained audit record` };
    }
    // The hash covers prev and event; anything else on the line would be unprotected.
    const extra = Object.keys(rec).filter((k) => k !== "prev" && k !== "hash" && k !== "event");
    if (extra.length > 0) return { ...at, reason: `line ${i + 1} has fields outside the chain (${extra.join(", ")})` };
    if (rec.prev !== prev) {
      return { ...at, reason: `line ${i + 1} does not follow the line before it: a line was removed, inserted or reordered` };
    }
    if ((await digest(rec.prev, rec.event, opts.key)) !== rec.hash) {
      return {
        ...at,
        reason: `line ${i + 1} was edited: its hash does not match its content${opts.key === undefined ? " (or the log was chained with a key, and none was given)" : " under this key (or the key is wrong)"}`,
      };
    }
    prev = rec.hash;
  }
  if (opts.head !== undefined && prev !== opts.head) {
    return { ok: false, count, line: physical.length, reason: "the newest line does not match the anchored head: the log was cut short or has diverged" };
  }
  return { ok: true, count, head: prev };
}
