import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { isBusyError, retryWhileBusy } from "./sqlite-busy.js";
import { SqliteMemoryStore } from "./sqlite-memory-store.js";

/**
 * B1 (release review, 2026-09-18), the second half: better-sqlite3's busy
 * timeout covers statements, not the exclusive lock `journal_mode = WAL` needs.
 * Two MCP servers started together on one database — the README's own
 * configuration, once a person runs two assistants — could fail outright at
 * construction rather than waiting their turn.
 */
describe("retryWhileBusy", () => {
  it("retries while SQLite says busy, and returns once it is not", () => {
    const waits: number[] = [];
    let calls = 0;
    const value = retryWhileBusy(
      () => {
        calls += 1;
        if (calls < 3) throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
        return "opened";
      },
      { sleep: (ms) => waits.push(ms) },
    );
    expect(value).toBe("opened");
    expect(calls).toBe(3);
    expect(waits).toEqual([5, 10]); // it backed off rather than spinning
  });

  it("gives up with the original error rather than hiding it", () => {
    const waits: number[] = [];
    expect(() =>
      retryWhileBusy(
        () => {
          throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
        },
        { attempts: 4, sleep: (ms) => waits.push(ms) },
      ),
    ).toThrow(/database is locked/);
    expect(waits).toHaveLength(3); // tried four times
  });

  it("does not retry anything that is not a busy lock", () => {
    let calls = 0;
    expect(() =>
      retryWhileBusy(
        () => {
          calls += 1;
          throw Object.assign(new Error("no such table"), { code: "SQLITE_ERROR" });
        },
        { sleep: () => undefined },
      ),
    ).toThrow(/no such table/);
    expect(calls).toBe(1);
  });

  it("knows a busy error from anything else", () => {
    expect(isBusyError(Object.assign(new Error(""), { code: "SQLITE_BUSY" }))).toBe(true);
    expect(isBusyError(Object.assign(new Error(""), { code: "SQLITE_BUSY_SNAPSHOT" }))).toBe(true);
    expect(isBusyError(Object.assign(new Error(""), { code: "SQLITE_ERROR" }))).toBe(false);
    expect(isBusyError(new Error("plain"))).toBe(false);
    expect(isBusyError(null)).toBe(false);
  });
});

describe("opening a database another connection is holding", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "al-buddy-busy-"));
    dbPath = join(dir, "brain.db");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("waits and retries rather than failing at the journal-mode switch", () => {
    // A connection in EXCLUSIVE locking mode never lets go, so this is the
    // pessimal case: the point is that the second store TRIES again instead of
    // giving up on the first SQLITE_BUSY, which is what it used to do.
    const hog = new Database(dbPath);
    hog.pragma("journal_mode = DELETE");
    hog.pragma("locking_mode = EXCLUSIVE");
    hog.prepare(`CREATE TABLE IF NOT EXISTS lock_holder (x INTEGER)`).run();

    const waits: number[] = [];
    let tries = 0;
    expect(() =>
      retryWhileBusy(
        () => {
          tries += 1;
          const second = new Database(dbPath, { timeout: 50 });
          try {
            second.pragma("journal_mode = WAL");
          } finally {
            second.close();
          }
        },
        { attempts: 4, sleep: (ms) => waits.push(ms) },
      ),
    ).toThrow();
    expect(tries).toBe(4);
    expect(waits).toEqual([5, 10, 20]);

    hog.close();
  });

  it("opens the same database twice in a row without complaint", async () => {
    const first = new SqliteMemoryStore(dbPath);
    const second = new SqliteMemoryStore(dbPath);
    const node = await first.addNode({
      provenance: "UserInput", encryptionKeyRef: "local", memoryType: "Experience",
      privacyClassification: "Private", retentionTier: "FullRetention",
      content: { text: "two connections, one file" },
      contextualMetadata: {}, confidenceWeight: 1, decayRate: 0,
    });
    expect((await second.getNode(node.nodeId))?.content.text).toBe("two connections, one file");
    first.close();
    second.close();
  });
});
