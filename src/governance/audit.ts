/**
 * The audit trail: an append-only record of every governed decision. Who
 * wrote, who read what, what was refused and by which policy. The sink is
 * pluggable; the in-memory one is for tests and single sessions, the JSONL
 * one for a file that survives the process.
 */
import { dirname, join } from "node:path";

import { GENESIS, LINE_LABELS, chainDigest, linkFault } from "./chain.js";
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

// ---------------------------------------------------------------------------
// The trail inside the database — an optional store capability
// ---------------------------------------------------------------------------

/**
 * An optional capability, not part of `MemoryStore` — the same shape as
 * `SnapshotCapable` in `src/types/memory.ts`, and for the same reason: a
 * third-party store must stay implementable without it. `SqliteMemoryStore`
 * implements it; `InMemoryStore` does not, and governs perfectly well with a
 * file sink.
 *
 * What it adds is the one thing a sink beside the database cannot do: commit a
 * governed mutation's event in the SAME transaction as the fact, so there is no
 * instant at which the fact exists and nothing attests to it.
 */
export interface AuditCapable {
  /**
   * Run `mutate` so that the event `describe` returns is appended in the same
   * transaction as whatever `mutate` changed. Either both land or neither does.
   *
   * `describe` is called with the mutation's result, because the event names
   * facts the store may only have identified during the write — `addNode`
   * mints the id. It runs inside the transaction, so it must not await.
   *
   * `mutate` must be one call into this store, and must not overlap another
   * audited mutation on it; `govern()` serialises every mutation over a store
   * object, which is what makes that true.
   */
  auditedMutation<T>(mutate: () => Promise<T>, describe: (result: T) => AuditEvent): Promise<T>;
  /** Append one event on its own, in its own transaction — a refusal or a read, which no fact accompanies. */
  recordAuditEvent(event: AuditEvent): Promise<void>;
  /** The hash of the newest event: the value to anchor somewhere this database's owner does not control. */
  auditHead(): Promise<string>;
}

export function isAuditCapable(store: unknown): store is AuditCapable {
  const s = store as Partial<AuditCapable> | null;
  return (
    typeof s === "object" &&
    s !== null &&
    typeof s.auditedMutation === "function" &&
    typeof s.recordAuditEvent === "function" &&
    typeof s.auditHead === "function"
  );
}

/**
 * The sink that IS the store: events go into the store's own `audit_events`
 * table. Hand it to `govern()` and every governed mutation commits with its
 * event; refusals and reads are appended on their own.
 *
 * Built through `storeAudit` so a store that cannot do this is refused at the
 * call that asks for it, rather than at the first write.
 */
export class StoreAudit implements AuditSink {
  constructor(readonly store: AuditCapable) {}
  record(event: AuditEvent): Promise<void> {
    return this.store.recordAuditEvent(event);
  }
  /** The value to anchor elsewhere — the only thing that catches a cut-off tail or a key holder's rewrite. */
  head(): Promise<string> {
    return this.store.auditHead();
  }
}

/** The store's own audit table as a sink. Throws if this store does not keep one. */
export function storeAudit(store: AuditCapable): StoreAudit {
  if (!isAuditCapable(store)) {
    throw new Error("this store does not keep an audit table; use ChainedAudit with a file, or a store that implements AuditCapable");
  }
  return new StoreAudit(store);
}

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

// The canonical form, the digest and the per-record check live in `chain.ts`,
// shared with the `audit_events` table: the two forms must hash a record
// identically, or a store that moved from one to the other would look tampered
// with and neither verifier could check the other's trail.

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
      const hash = chainDigest(prev, plain, this.#key);
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
  /** `form` says which trail each result came from: a file of JSON lines, or the database's own table. */
  logs: { file: string; form: "jsonl" | "table"; result: AuditChainResult }[];
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
    const { isSqliteFile, verifyAuditTable } = await import("./audit-table.js");
    if (await isSqliteFile(path)) {
      // A database carries its own chain. It may ALSO have per-process JSONL
      // logs beside it from before it did, and those cover a period the table
      // cannot attest to — so both are reported, and switching to the table
      // cannot quietly retire the files.
      const logs: AuditLogsResult["logs"] = [{ file: path, form: "table", result: await verifyAuditTable(path, opts) }];
      // `head` anchors ONE chain — the table's. The files are checked on their own terms.
      const { head: _pinned, ...withoutHead } = opts;
      // Both shapes a log beside a database has ever had: 0.4.2's directory of
      // one file per process, and 0.4.1's single file. A store the founder has
      // been running since before 0.4.2 has the second, and a verifier that
      // silently ignored it would be the "delete a log and the rest verify
      // clean" problem in a new costume.
      for (const beside of [`${path}.audit`, `${path}.audit.jsonl`]) {
        let kind: "dir" | "file" | null = null;
        try {
          kind = (await stat(beside)).isDirectory() ? "dir" : "file";
        } catch {
          kind = null;
        }
        if (kind === "file") logs.push({ file: beside, form: "jsonl", result: await verifyAuditChain(beside, withoutHead) });
        else if (kind === "dir") {
          for (const file of (await readdir(beside)).filter((f) => f.endsWith(".jsonl")).sort().map((f) => join(beside, f))) {
            logs.push({ file, form: "jsonl", result: await verifyAuditChain(file, withoutHead) });
          }
        }
      }
      return { ok: logs.every((l) => l.result.ok), logs };
    }
    const result = await verifyAuditChain(path, opts);
    return { ok: result.ok, logs: [{ file: path, form: "jsonl", result }] };
  }

  // An anchored head belongs to one chain. Saying which one is the caller's job.
  if (opts.head !== undefined) return { ok: false, logs: [], reason: `--head names one log file, not a directory of them: ${path}` };
  const files = (await readdir(path)).filter((f) => f.endsWith(".jsonl")).sort().map((f) => join(path, f));
  if (files.length === 0) return { ok: false, logs: [], reason: `no logs (*.jsonl) in ${path}` };
  const logs: AuditLogsResult["logs"] = [];
  for (const file of files) logs.push({ file, form: "jsonl" as const, result: await verifyAuditChain(file, opts) });
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
    const fault = linkFault(rec, prev, opts.key, i + 1, LINE_LABELS);
    if (fault !== null) return { ...at, reason: fault };
    prev = rec.hash as string;
  }
  if (opts.head !== undefined && prev !== opts.head) {
    return { ok: false, count, line: physical.length, reason: "the newest line does not match the anchored head: the log was cut short or has diverged" };
  }
  return { ok: true, count, head: prev };
}
