/**
 * `audit_events` — the audit trail as a table inside the database it describes.
 *
 * What this buys, and it is exactly three things:
 *
 * 1. **No commit-before-event window.** The append runs inside the mutation's
 *    own SQLite transaction, so the fact and the event land together or neither
 *    does. The JSONL sinks write after the store call returns, which leaves one
 *    committed write unattested when the sink fails (C1 in the ledger).
 * 2. **One chain, not a directory of them.** A JSONL chain has one writer, so
 *    two processes need two files, and a set of files has no manifest: delete
 *    one and the rest verify clean. Here the tail is read and extended inside
 *    the same `BEGIN IMMEDIATE` transaction, so many processes share one chain
 *    and a missing record breaks the link at the record after it.
 * 3. **A restored backup is visibly a different history.** The chain is inside
 *    the file, so restoring an older copy of the database restores an older,
 *    self-consistent chain — which disagrees with any head anchored elsewhere.
 *
 * What it does NOT buy, and must never be written as if it did:
 *
 * - It is tamper-**evident**, not tamper-proof, exactly as the file form is.
 *   Whoever holds the HMAC key (or, with no key, whoever can write the file)
 *   can recompute the whole chain. The answer is the same as before: publish
 *   `head()` somewhere the database's owner does not control.
 * - A cut-off tail is invisible to the file itself. Truncating the newest
 *   records leaves a chain that verifies. Only an anchored head catches it.
 * - It says nothing about **authorisation** across processes. The decision a
 *   policy took still happens before the transaction opens; two processes can
 *   still interleave a check and a write (C3 in the ledger stays open).
 */
import type Database from "better-sqlite3";

import type { AuditEvent } from "./audit.js";
import { EVENT_LABELS, GENESIS, chainDigest, linkFault, type ChainRecord } from "./chain.js";

/** Added by schema v7. `AUTOINCREMENT` so a deleted seq is never handed out again. */
export const AUDIT_EVENTS_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS audit_events (
    seq   INTEGER PRIMARY KEY AUTOINCREMENT,
    prev  TEXT NOT NULL,
    hash  TEXT NOT NULL,
    event TEXT NOT NULL
  )`,
];

interface EventRow {
  seq: number;
  prev: string;
  hash: string;
  event: string;
}

export type AuditTableResult =
  | { ok: true; count: number; head: string }
  | { ok: false; count: number; line: number; reason: string };

/**
 * Walk a chain of records in order. Shared by the live append (which must know
 * the chain is sound before extending it) and by `verify-audit`.
 */
function walk(records: { seq: number; prev: string; hash: string; event: string }[], key: string | undefined, head?: string): AuditTableResult {
  let prev = GENESIS;
  for (const [i, row] of records.entries()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.event);
    } catch {
      return { ok: false, count: records.length, line: i + 1, reason: `${EVENT_LABELS.at(i + 1)} (seq ${row.seq}) does not hold JSON` };
    }
    const fault = linkFault({ prev: row.prev, hash: row.hash, event: parsed } satisfies ChainRecord, prev, key, i + 1, EVENT_LABELS);
    if (fault !== null) return { ok: false, count: records.length, line: i + 1, reason: `${fault} (seq ${row.seq})` };
    prev = row.hash;
  }
  if (head !== undefined && prev !== head) {
    return { ok: false, count: records.length, line: records.length, reason: "the newest event does not match the anchored head: the table was cut short or has diverged" };
  }
  return { ok: true, count: records.length, head: prev };
}

/**
 * The live chain on an open database. One per store; the tail is re-read on
 * every append rather than cached, because another process may have extended
 * it since — that is the whole point of keeping it here.
 */
export class AuditEventTable {
  #checked = false;

  constructor(
    private readonly db: Database.Database,
    private readonly key: string | undefined,
  ) {}

  /**
   * Append one event, chained to whatever is currently last.
   *
   * MUST be called inside a write transaction — the caller's, so the event
   * commits with the fact. `SqliteMemoryStore.mutation()` is the only caller
   * that matters; it takes `BEGIN IMMEDIATE`, so the tail read here cannot be
   * read by another process at the same time.
   */
  append(event: AuditEvent): void {
    this.assertSound();
    const prev = this.tail();
    // Through JSON first, exactly as the file form does, so an `undefined`
    // field is dropped the same way and the two hash identically.
    const plain = JSON.parse(JSON.stringify(event)) as AuditEvent;
    const hash = chainDigest(prev, plain, this.key);
    this.db.prepare(`INSERT INTO audit_events (prev, hash, event) VALUES (?, ?, ?)`).run(prev, hash, JSON.stringify(plain));
  }

  /** The hash of the newest event — the value to anchor outside this database. */
  head(): string {
    this.assertSound();
    return this.tail();
  }

  private tail(): string {
    const row = this.db.prepare(`SELECT hash FROM audit_events ORDER BY seq DESC LIMIT 1`).get() as { hash?: string } | undefined;
    return typeof row?.hash === "string" ? row.hash : GENESIS;
  }

  /**
   * Refuse to extend a chain that does not already verify, which is what
   * `ChainedAudit` does when it opens a file. Once per store object: the cost
   * is one pass over the table, and re-checking on every append would make a
   * write O(events).
   *
   * The honest limit of "once": a chain this process verified at its first
   * write and another process corrupted afterwards will keep being extended
   * here. Verification at read time still names the break.
   */
  private assertSound(): void {
    if (this.#checked) return;
    const result = this.verify();
    if (!result.ok) {
      throw new Error(
        `the audit_events chain in this database does not verify${this.key === undefined ? "" : " with this key"} (${result.reason}); refusing to extend it — check it with \`al-buddy-memory verify-audit\``,
      );
    }
    this.#checked = true;
  }

  verify(opts: { head?: string } = {}): AuditTableResult {
    const rows = this.db.prepare(`SELECT seq, prev, hash, event FROM audit_events ORDER BY seq`).all() as EventRow[];
    return walk(rows, this.key, opts.head);
  }
}

/**
 * Check the chain in a database file, without opening it as a store — what
 * `al-buddy-memory verify-audit <db>` calls. Read-only, so it cannot migrate a
 * file it was pointed at by mistake.
 */
export async function verifyAuditTable(dbPath: string, opts: { key?: string; head?: string } = {}): Promise<AuditTableResult> {
  const { default: Sqlite } = await import("better-sqlite3");
  let db: Database.Database | undefined;
  try {
    db = new Sqlite(dbPath, { readonly: true, fileMustExist: true });
    const present = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'audit_events'`).get() as { name?: string } | undefined;
    if (present?.name !== "audit_events") {
      // Never call a database with no trail "intact: 0 events".
      return { ok: false, count: 0, line: 0, reason: `${dbPath} has no audit_events table: it was written before the table existed, or it is not an al-buddy-memory database` };
    }
    const rows = db.prepare(`SELECT seq, prev, hash, event FROM audit_events ORDER BY seq`).all() as EventRow[];
    return walk(rows, opts.key, opts.head);
  } catch (err) {
    return { ok: false, count: 0, line: 0, reason: `cannot read ${dbPath}: ${(err as Error).message}` };
  } finally {
    db?.close();
  }
}

/** Does this file start with SQLite's magic header? Decides which verifier to use. */
export async function isSqliteFile(path: string): Promise<boolean> {
  const { open } = await import("node:fs/promises");
  let handle;
  try {
    handle = await open(path, "r");
    const buf = Buffer.alloc(16);
    const { bytesRead } = await handle.read(buf, 0, 16, 0);
    return bytesRead === 16 && buf.toString("utf8", 0, 15) === "SQLite format 3";
  } catch {
    return false;
  } finally {
    await handle?.close();
  }
}
