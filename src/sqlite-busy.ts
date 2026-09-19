/**
 * SQLITE_BUSY, on the two steps better-sqlite3's busy timeout does not cover.
 *
 * better-sqlite3 applies `timeout` to statement execution. It does not apply to
 * the `journal_mode = WAL` switch — changing journal mode needs an exclusive
 * lock and returns SQLITE_BUSY immediately if another connection holds one — and
 * a fresh database's first write can land in the same moment. Two MCP servers
 * started together on one database (the common case: two assistants, one brain)
 * hit exactly this (B1, release review 2026-09-18).
 *
 * The constructor is synchronous, so the wait has to be too: `Atomics.wait` on a
 * throwaway SharedArrayBuffer parks the thread without spinning.
 */

/** SQLite result codes that mean "someone else holds the lock; try again". */
const BUSY = new Set(["SQLITE_BUSY", "SQLITE_BUSY_SNAPSHOT", "SQLITE_BUSY_RECOVERY", "SQLITE_BUSY_TIMEOUT", "SQLITE_PROTOCOL"]);

export function isBusyError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" && (BUSY.has(code) || code.startsWith("SQLITE_BUSY"));
}

/** Block this thread for `ms`, with no busy-wait. */
export function sleepSync(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export interface RetryWhileBusyOptions {
  /** Total tries, the first one included. Default 14 — about a second of waiting. */
  attempts?: number;
  /** First wait in ms; doubles up to `maxWaitMs`. Default 5. */
  waitMs?: number;
  maxWaitMs?: number;
  /** For tests: the wait itself. */
  sleep?: (ms: number) => void;
}

/**
 * Run `step`, retrying only while SQLite says another connection holds the lock.
 * Any other error, and the last SQLITE_BUSY, are thrown as they came — a caller
 * still sees the real reason it could not open the database.
 */
export function retryWhileBusy<T>(step: () => T, options: RetryWhileBusyOptions = {}): T {
  const attempts = options.attempts ?? 14;
  const maxWait = options.maxWaitMs ?? 100;
  const sleep = options.sleep ?? sleepSync;
  let wait = options.waitMs ?? 5;
  for (let attempt = 1; ; attempt++) {
    try {
      return step();
    } catch (err) {
      if (attempt >= attempts || !isBusyError(err)) throw err;
      sleep(wait);
      wait = Math.min(wait * 2, maxWait);
    }
  }
}
