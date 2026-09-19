import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ChainedAudit, auditLogPath, verifyAuditChain, verifyAuditLogs, type AuditEvent } from "./audit.js";

/**
 * B1 (release review, 2026-09-18): the README's MCP config is one `npx` per
 * host, and the server's own instructions say the memory is "shared across
 * their assistants" — so two clients open two processes on one database. Each
 * process cached its own chain head, the two appends interleaved, and the log
 * forked. After that every server refused to start, because refusing to extend
 * a broken chain is (correctly) what it does.
 *
 * The fix is one chained log per writer — `<db>.audit/<start>-<pid>.jsonl` —
 * and a verifier that takes the directory. A lock file would instead have made
 * the second assistant fail to start, which is worse.
 */

const event = (actor: string, n: number): AuditEvent => ({
  at: new Date(2026, 8, 18, 12, 0, n).toISOString(),
  actor,
  purpose: "write",
  outcome: "allowed",
  nodeIds: [`node-${n}`],
  count: 1,
});

describe("one chained log per writer", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "al-buddy-audit-writers-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("names a log for the process that writes it, with nothing a filesystem dislikes", () => {
    const db = join(dir, "brain.db");
    const at = new Date("2026-09-18T20:49:03.125Z");
    const mine = auditLogPath(db, { at, pid: 4242 });
    const theirs = auditLogPath(db, { at, pid: 4243 });

    expect(dirname(mine)).toBe(`${db}.audit`);
    expect(mine).not.toBe(theirs);
    expect(mine.slice(`${db}.audit/`.length)).toBe("2026-09-18T20-49-03.125Z-4242.jsonl");
    expect(mine).not.toContain(":");
    // Two processes started in the same millisecond still differ by pid.
    expect(auditLogPath(db, { at, pid: 1 })).not.toBe(auditLogPath(db, { at, pid: 2 }));
  });

  it("forks the chain when two writers share one file (the failure being fixed)", async () => {
    const shared = join(dir, "shared.jsonl");
    const first = new ChainedAudit(shared);
    const second = new ChainedAudit(shared);
    // Both read the head before either appends — two MCP servers starting together.
    await Promise.all([first.head(), second.head()]);
    await first.record(event("first", 1));
    await second.record(event("second", 2));

    const result = await verifyAuditChain(shared);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/does not follow the line before it/);
  });

  it("keeps two writers intact when each has its own log, and verifies them together", async () => {
    const db = join(dir, "brain.db");
    const at = new Date("2026-09-18T20:49:03.125Z");
    const first = new ChainedAudit(auditLogPath(db, { at, pid: 4242 }));
    const second = new ChainedAudit(auditLogPath(db, { at, pid: 4243 }));
    await Promise.all([first.head(), second.head()]);
    await first.record(event("first", 1));
    await second.record(event("second", 2));
    await first.record(event("first", 3));

    // The directory did not exist before the first append; the sink made it.
    expect(readdirSync(`${db}.audit`).sort()).toEqual(["2026-09-18T20-49-03.125Z-4242.jsonl", "2026-09-18T20-49-03.125Z-4243.jsonl"]);

    const all = await verifyAuditLogs(`${db}.audit`);
    expect(all.ok).toBe(true);
    expect(all.logs).toHaveLength(2);
    expect(all.logs.map((l) => (l.result.ok ? l.result.count : -1))).toEqual([2, 1]);
  });

  it("does not stop a new writer because another writer's log is broken", async () => {
    const db = join(dir, "brain.db");
    const broken = auditLogPath(db, { at: new Date("2026-09-18T20:00:00.000Z"), pid: 1 });
    const fresh = auditLogPath(db, { at: new Date("2026-09-18T21:00:00.000Z"), pid: 2 });
    const sink = new ChainedAudit(broken);
    await sink.record(event("first", 1));
    writeFileSync(broken, `{"prev":"0","hash":"nonsense","event":{}}\n`, { flag: "a" });

    // A server starting now gets its own log and starts — that is the whole point.
    const mine = new ChainedAudit(fresh);
    await expect(mine.head()).resolves.toMatch(/^[0]{64}$/);
    await mine.record(event("second", 2));

    // And the verifier still names the broken one.
    const all = await verifyAuditLogs(`${db}.audit`);
    expect(all.ok).toBe(false);
    const bad = all.logs.find((l) => l.file === broken);
    expect(bad?.result.ok).toBe(false);
    expect(all.logs.find((l) => l.file === fresh)?.result.ok).toBe(true);
  });

  it("still verifies a single file, and says so when there is nothing to verify", async () => {
    const one = join(dir, "single.jsonl");
    const sink = new ChainedAudit(one);
    await sink.record(event("only", 1));
    const single = await verifyAuditLogs(one);
    expect(single.ok).toBe(true);
    expect(single.logs).toHaveLength(1);

    const empty = await verifyAuditLogs(join(dir, "empty.audit"));
    expect(empty.ok).toBe(false);
    expect(empty.reason).toMatch(/no such file|no logs/i);
  });

  it("checks an anchored head against one log, and refuses to guess which one in a directory", async () => {
    const one = join(dir, "single.jsonl");
    const sink = new ChainedAudit(one);
    await sink.record(event("only", 1));
    const head = await sink.head();
    expect((await verifyAuditLogs(one, { head })).ok).toBe(true);
    expect((await verifyAuditLogs(one, { head: "0".repeat(64) })).ok).toBe(false);

    const db = join(dir, "brain.db");
    await new ChainedAudit(auditLogPath(db, { pid: 7 })).record(event("a", 1));
    const guessed = await verifyAuditLogs(`${db}.audit`, { head });
    expect(guessed.ok).toBe(false);
    expect(guessed.reason).toMatch(/one log/i);
  });
});
