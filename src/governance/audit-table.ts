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
/**
 * One pass over the chain, STREAMING.
 *
 * `records` is iterated, never materialised: a trail is append-only and grows
 * without bound, and `.all()` here meant the whole table in memory — measured
 * at 200,000 events, 68 MB on disk, ~500 MB RSS to check it, and the check runs
 * inside the first write's transaction (Fable 5.1, 2026-09-19). Streaming makes
 * the memory cost of verifying a chain independent of its length; the time cost
 * is still one pass, by construction.
 *
 * `total` is passed in rather than counted here so that "BROKEN at event 3 of
 * 5" can still name the whole table when the walk stops early. It is one
 * `COUNT(*)` against the primary key.
 */
function walk(records: Iterable<{ seq: number; prev: string; hash: string; event: string }>, total: number, key: string | undefined, head?: string): AuditTableResult {
  let prev = GENESIS;
  let seen = 0;
  for (const row of records) {
    seen++;
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.event);
    } catch {
      return { ok: false, count: total, line: seen, reason: `${EVENT_LABELS.at(seen)} (seq ${row.seq}) does not hold JSON` };
    }
    const fault = linkFault({ prev: row.prev, hash: row.hash, event: parsed } satisfies ChainRecord, prev, key, seen, EVENT_LABELS);
    if (fault !== null) return { ok: false, count: total, line: seen, reason: `${fault} (seq ${row.seq})` };
    prev = row.hash;
  }
  if (head !== undefined && prev !== head) {
    return { ok: false, count: seen, line: seen, reason: "the newest event does not match the anchored head: the table was cut short or has diverged" };
  }
  return { ok: true, count: seen, head: prev };
}

/**
 * What the table itself knows about records that are no longer in it.
 *
 * A chain cannot prove its own tail: cut the newest records off and what remains
 * verifies, which is why an anchored head hash is the only real answer and says
 * so throughout these docs. That is true of a log FILE. A table has one more
 * thing in it — `AUTOINCREMENT` keeps a high-water mark in `sqlite_sequence`
 * that a `DELETE` does not roll back (measured for all three deletion shapes,
 * 2026-09-19: emptying the table, a `WHERE`-qualified delete, and cutting the
 * newest rows all leave the mark standing).
 *
 * So the table can catch, for free and without an anchor, the two cases that
 * used to verify clean: records cut from the END, and a trail wiped and then
 * kept in use — whose first surviving record claims to be the genesis of a
 * chain whose sequence number says it is not.
 *
 * This is NOT tamper-proofing and must not be described as it: whoever can
 * delete the records can reset the counter in the same breath. It catches
 * accident and careless deletion, which is most of what actually happens to a
 * file. A deliberate edit still needs the anchored head.
 *
 * Reported by the second reviewer of the audit-chain merge, 2026-09-19, which
 * noticed the evidence was already in the file and nothing read it.
 */
function tailFault(db: Database.Database, count: number, lastSeq: number | null, firstSeq: number | null): string | null {
  const mark = db.prepare(`SELECT seq FROM sqlite_sequence WHERE name = 'audit_events'`).get() as { seq?: number } | undefined;
  if (mark?.seq === undefined) return null; // nothing was ever appended: no claim to check
  if (count === 0) {
    return `the table is empty but ${mark.seq} event${mark.seq === 1 ? " was" : "s were"} appended to it: the trail was deleted`;
  }
  if (lastSeq !== null && lastSeq < mark.seq) {
    return `the newest event is seq ${lastSeq} but seq ${mark.seq} was reached: ${mark.seq - lastSeq} record(s) were removed from the end`;
  }
  if (firstSeq !== null && firstSeq !== 1) {
    return `the chain starts at seq ${firstSeq} rather than 1: everything before it was deleted`;
  }
  return null;
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
  /**
   * The one-time verification, run OUTSIDE any transaction the caller is about
   * to open. `append` calls `assertSound` too, so correctness never depends on
   * anyone calling this — but if the first append is the first check, the walk
   * happens while the write lock is held, and one pass over a long chain is a
   * long time to hold it (measured: 723 ms at 200,000 events). Called before
   * the transaction opens, the same work blocks nobody.
   *
   * Nothing is weakened by checking early: the chain may be corrupted by
   * another process between this and the append, and that was already the
   * documented limit of checking once (see `assertSound`).
   */
  ensureChecked(): void {
    this.assertSound();
  }

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
    return verifyOpenTable(this.db, this.key, opts.head);
  }
}

/** One pass plus the tail check, over an already-open database. */
function verifyOpenTable(db: Database.Database, key: string | undefined, head?: string): AuditTableResult {
  const bounds = db.prepare(`SELECT COUNT(*) AS n, MIN(seq) AS lo, MAX(seq) AS hi FROM audit_events`).get() as { n: number; lo: number | null; hi: number | null };
  const rows = db.prepare(`SELECT seq, prev, hash, event FROM audit_events ORDER BY seq`).iterate() as Iterable<EventRow>;
  const walked = walk(rows, bounds.n, key, head);
  if (!walked.ok) return walked;
  const cut = tailFault(db, bounds.n, bounds.hi, bounds.lo);
  return cut === null ? walked : { ok: false, count: bounds.n, line: bounds.n, reason: cut };
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
    return verifyOpenTable(db, opts.key, opts.head);
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
