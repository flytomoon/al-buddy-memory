import Database from "better-sqlite3";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { InMemoryStore } from "../in-memory-store.js";
import { SqliteMemoryStore } from "../sqlite-memory-store.js";
import type { NewMemoryNode } from "../types/memory.js";
import { ChainedAudit, storeAudit, verifyAuditLogs, type AuditEvent, type AuditSink } from "./audit.js";
import { govern } from "./governed-store.js";
import type { GovernancePolicy } from "./policy.js";

/**
 * C1 in docs/RESILIENCE-LEDGER.md: a governed mutation commits, and THEN its
 * event is written, so a sink that fails at that instant leaves the fact in the
 * database with nothing attesting to it. Documented as a bound of one write,
 * and only closable by writing both in one transaction.
 *
 * `audit_events` is that transaction: the event is appended inside the
 * mutation's own SQLite transaction, so the two land together or neither does.
 */

const base = {
  provenance: "UserInput" as const,
  encryptionKeyRef: "test",
  memoryType: "Experience" as const,
  privacyClassification: "Private" as const,
  retentionTier: "FullRetention" as const,
  contextualMetadata: {},
  confidenceWeight: 1,
  decayRate: 0,
};
const node = (text: string): NewMemoryNode => ({ ...base, content: { text } });

const allowErase: GovernancePolicy = { name: "allow-erase", beforeErase: () => true };

interface EventRow {
  seq: number;
  prev: string;
  hash: string;
  event: string;
}

/** The chain as it sits in the file, read with a second connection. */
function rows(dbPath: string): (EventRow & { parsed: AuditEvent })[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return (db.prepare(`SELECT seq, prev, hash, event FROM audit_events ORDER BY seq`).all() as EventRow[]).map((r) => ({
      ...r,
      parsed: JSON.parse(r.event) as AuditEvent,
    }));
  } finally {
    db.close();
  }
}

describe("the audit event and the fact it describes are one transaction", () => {
  let dir: string;
  let dbPath: string;
  let store: SqliteMemoryStore | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "al-buddy-audit-table-"));
    dbPath = join(dir, "memory.db");
  });

  afterEach(() => {
    store?.close();
    store = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes one chained event per governed mutation, into the database", async () => {
    store = new SqliteMemoryStore(dbPath);
    const governed = govern(store, { policies: [allowErase], context: () => ({ actor: "owner" }), audit: storeAudit(store) });

    const first = await governed.addNode(node("a fact"));
    await governed.updateNode(first.nodeId, { confidenceWeight: 0.5 });
    await governed.deleteNode(first.nodeId);

    const chain = rows(dbPath);
    // Three mutations, three "allowed" events; reads are audited too, so filter.
    const mutations = chain.filter((r) => r.parsed.outcome === "allowed" && r.parsed.purpose !== "recall");
    expect(mutations.map((r) => r.parsed.purpose)).toEqual(["write", "write", "erase"]);
    expect(mutations.every((r) => r.parsed.nodeIds.includes(first.nodeId))).toBe(true);
    // One chain: every record carries the hash of the one before it.
    expect(chain[0]!.prev).toBe("0".repeat(64));
    for (let i = 1; i < chain.length; i++) expect(chain[i]!.prev).toBe(chain[i - 1]!.hash);
  });

  it("leaves NO fact behind when the event cannot be written (the C1 window, closed)", async () => {
    store = new SqliteMemoryStore(dbPath);
    const governed = govern(store, { policies: [], context: () => ({ actor: "owner" }), audit: storeAudit(store) });

    await governed.addNode(node("before"));
    const beforeCount = (await store.listNodes()).length;

    // Break the chain the way a corrupted row breaks it: the append reads the
    // tail and refuses to extend something that does not verify.
    const tamper = new Database(dbPath);
    tamper.prepare(`UPDATE audit_events SET event = ? WHERE seq = (SELECT MIN(seq) FROM audit_events)`).run(JSON.stringify({ tampered: true }));
    tamper.close();

    // A fresh store, so the chain is read rather than trusted from memory.
    store.close();
    store = new SqliteMemoryStore(dbPath);
    const after = govern(store, { policies: [], context: () => ({ actor: "owner" }), audit: storeAudit(store) });
    await expect(after.addNode(node("during the failure"))).rejects.toThrow(/verify|chain/i);

    // The JSONL path leaves this one fact committed with no event. The table
    // path leaves nothing: the mutation rolled back with its event.
    const texts = (await store.listNodes()).map((n) => n.content.text);
    expect(texts).not.toContain("during the failure");
    expect(texts).toHaveLength(beforeCount);
  });

  it("is what the shipped MCP server's store writes to", async () => {
    // `bin/al-buddy-memory-mcp.js` builds exactly this: the store, then
    // storeAudit(store) as the sink. The default matters — it is the two-process
    // setup the split-log layout existed for.
    const { serverStore } = await import("../mcp/governance-server.js");
    store = new SqliteMemoryStore(dbPath);
    const served = serverStore(store, { owner: "owner", audit: storeAudit(store) });
    const saved = await served.addNode(node("remembered through the server"));
    expect(rows(dbPath).some((r) => r.parsed.outcome === "allowed" && r.parsed.nodeIds.includes(saved.nodeId))).toBe(true);
  });

  it("does not write an event for a mutation a policy refused", async () => {
    store = new SqliteMemoryStore(dbPath);
    const refuse: GovernancePolicy = {
      name: "no-writes",
      beforeWrite: () => {
        throw new (class extends Error {})("nope");
      },
    };
    const governed = govern(store, { policies: [refuse], context: () => ({ actor: "owner" }), audit: storeAudit(store) });
    await expect(governed.addNode(node("refused"))).rejects.toThrow();
    expect((await store.listNodes()).length).toBe(0);
    // A thrown non-PolicyDenied is not audited (it is not a governance decision),
    // and nothing was stored, so the chain stays empty.
    expect(rows(dbPath)).toHaveLength(0);
  });

  it("records a PolicyDenied refusal on its own, with no fact", async () => {
    store = new SqliteMemoryStore(dbPath);
    const governed = govern(store, { policies: [], context: () => ({ actor: "owner" }), audit: storeAudit(store) });
    const first = await governed.addNode(node("a fact"));
    // No policy allows erasure, so deleteNode is denied.
    await expect(governed.deleteNode(first.nodeId)).rejects.toThrow(/erasure is not enabled/);

    const denied = rows(dbPath).filter((r) => r.parsed.outcome === "denied");
    expect(denied).toHaveLength(1);
    expect(denied[0]!.parsed.purpose).toBe("erase");
    expect((await store.listNodes()).length).toBe(1);
  });

  it("recovers from a transient sink failure instead of latching the store shut", async () => {
    // On the JSONL path a failed sink latches: nothing more is written until the
    // process restarts, because the failure left one unrecorded write behind.
    // Here there is no unrecorded write to protect, so a store that failed once
    // works again — proved by making one append fail and no others.
    store = new SqliteMemoryStore(dbPath);
    const governed = govern(store, { policies: [], context: () => ({ actor: "owner" }), audit: storeAudit(store) });

    const real = Database.prototype.prepare;
    let failures = 1;
    Database.prototype.prepare = function (this: Database.Database, sql: string) {
      if (failures > 0 && /INSERT INTO audit_events/.test(sql)) {
        failures--;
        throw new Error("SQLITE_FULL: database or disk is full");
      }
      return real.call(this, sql);
    } as typeof Database.prototype.prepare;
    try {
      await expect(governed.addNode(node("lost"))).rejects.toThrow(/SQLITE_FULL/);
    } finally {
      Database.prototype.prepare = real;
    }

    expect((await store.listNodes()).map((n) => n.content.text)).not.toContain("lost");
    // Not latched: the next mutation goes through, with its event.
    const ok = await governed.addNode(node("after"));
    expect(rows(dbPath).some((r) => r.parsed.nodeIds.includes(ok.nodeId))).toBe(true);
  });

  /**
   * The test above fails the append of a MUTATION's event, which is the case
   * the table was built for. Reads and refusals do not go through
   * `commitAudited` — they call `record()`, which latches any sink it is given,
   * this table included. So a disk-full during a governed SEARCH bricked a store
   * that had lost nothing, which is exactly what four places in the docs said
   * could not happen (Fable 5.1, reviewing the merge, 2026-09-19 — reproduced
   * with a real SQLITE_FULL, not only a monkeypatch).
   *
   * The rule the latch encodes: refuse further writes while an unrecorded write
   * may exist. On this path none can, whichever kind of event failed.
   */
  for (const kind of ["a read", "a refusal"] as const) {
    it(`does not latch when the failed event belongs to ${kind}`, async () => {
      store = new SqliteMemoryStore(dbPath);
      const governed = govern(store, { policies: [], context: () => ({ actor: "owner" }), audit: storeAudit(store) });
      const existing = await governed.addNode(node("a fact that exists"));

      const real = Database.prototype.prepare;
      let failures = 1;
      Database.prototype.prepare = function (this: Database.Database, sql: string) {
        if (failures > 0 && /INSERT INTO audit_events/.test(sql)) {
          failures--;
          throw new Error("SQLITE_FULL: database or disk is full");
        }
        return real.call(this, sql);
      } as typeof Database.prototype.prepare;
      try {
        // Both of these audit through `record()`: a read's "allowed", and the
        // "denied" of an erasure no policy permits.
        const attempt = kind === "a read" ? governed.searchNodes("fact") : governed.deleteNode(existing.nodeId);
        await expect(attempt).rejects.toThrow(/SQLITE_FULL/);
      } finally {
        Database.prototype.prepare = real;
      }

      // Nothing was lost — a read changes nothing, and a refusal refuses. So the
      // next write must go through, carrying its own event.
      const ok = await governed.addNode(node("after the failed event"));
      expect(rows(dbPath).some((r) => r.parsed.nodeIds.includes(ok.nodeId))).toBe(true);
    });
  }
});

describe("verify-audit reads the table", () => {
  let dir: string;
  let dbPath: string;
  let store: SqliteMemoryStore | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "al-buddy-audit-verify-"));
    dbPath = join(dir, "memory.db");
  });

  afterEach(() => {
    store?.close();
    store = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  async function threeEvents(key?: string): Promise<void> {
    store = new SqliteMemoryStore(dbPath, key === undefined ? {} : { auditKey: key });
    const governed = govern(store, { policies: [], context: () => ({ actor: "owner" }), audit: storeAudit(store) });
    await governed.addNode(node("one"));
    await governed.addNode(node("two"));
    await governed.addNode(node("three"));
    store.close();
    store = undefined;
  }

  it("verifies a database's chain, and names its head", async () => {
    await threeEvents();
    const checked = await verifyAuditLogs(dbPath);
    expect(checked.ok).toBe(true);
    expect(checked.logs).toHaveLength(1);
    expect(checked.logs[0]!.form).toBe("table");
    const result = checked.logs[0]!.result;
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.head).toMatch(/^[0-9a-f]{64}$/);
  });

  it("names the event that was deleted — one chain, so a gap cannot verify clean", async () => {
    await threeEvents();
    const db = new Database(dbPath);
    const middle = (db.prepare(`SELECT seq FROM audit_events ORDER BY seq`).all() as { seq: number }[])[1]!.seq;
    db.prepare(`DELETE FROM audit_events WHERE seq = ?`).run(middle);
    db.close();

    const checked = await verifyAuditLogs(dbPath);
    expect(checked.ok).toBe(false);
    expect(checked.logs[0]!.result).toMatchObject({ ok: false, reason: expect.stringMatching(/removed, inserted or reordered/) });
  });

  it("names the event that was edited", async () => {
    await threeEvents();
    const db = new Database(dbPath);
    db.prepare(`UPDATE audit_events SET event = json_set(event, '$.actor', 'someone-else') WHERE seq = (SELECT MIN(seq) FROM audit_events)`).run();
    db.close();

    const checked = await verifyAuditLogs(dbPath);
    expect(checked.ok).toBe(false);
    expect(checked.logs[0]!.result).toMatchObject({ ok: false, reason: expect.stringMatching(/was edited/) });
  });

  it("refuses a chain written under a key when no key is given", async () => {
    await threeEvents("a-secret");
    expect((await verifyAuditLogs(dbPath)).ok).toBe(false);
    expect((await verifyAuditLogs(dbPath, { key: "a-secret" })).ok).toBe(true);
    expect((await verifyAuditLogs(dbPath, { key: "wrong" })).ok).toBe(false);
  });

  it("checks a JSONL log beside the database as well as the table", async () => {
    // An existing store with 0.4.2-era logs beside it: both are reported, so
    // switching to the table cannot hide the period the files cover.
    await threeEvents();
    const logDir = `${dbPath}.audit`;
    const log = new ChainedAudit(join(logDir, "2026-09-19T00-00-00.000Z-1.jsonl"));
    await log.record({ at: new Date().toISOString(), actor: "owner", purpose: "write", outcome: "allowed", nodeIds: ["old"], count: 1 });

    const checked = await verifyAuditLogs(dbPath);
    expect(existsSync(logDir)).toBe(true);
    expect(checked.logs.map((l) => l.form)).toEqual(["table", "jsonl"]);
    expect(checked.ok).toBe(true);
  });

  it("checks a 0.4.1-shaped single log beside the database too", async () => {
    // The founder's own store has `<db>.audit.jsonl` — the shape before the
    // per-process directory. A verifier that ignored it would be the
    // "delete a log and the rest verify clean" problem again.
    await threeEvents();
    const log = new ChainedAudit(`${dbPath}.audit.jsonl`);
    await log.record({ at: new Date().toISOString(), actor: "owner", purpose: "write", outcome: "allowed", nodeIds: ["older still"], count: 1 });

    const checked = await verifyAuditLogs(dbPath);
    expect(checked.logs.map((l) => l.form)).toEqual(["table", "jsonl"]);
    expect(checked.logs[1]!.file).toBe(`${dbPath}.audit.jsonl`);
    expect(checked.ok).toBe(true);
  });

  it("says so when a database has no audit table rather than calling it intact", async () => {
    const plain = join(dir, "plain.db");
    const db = new Database(plain);
    db.prepare(`CREATE TABLE t (x TEXT)`).run();
    db.close();
    const checked = await verifyAuditLogs(plain);
    expect(checked.ok).toBe(false);
    expect(checked.logs[0]?.result.ok ?? false).toBe(false);
    expect(JSON.stringify(checked)).toMatch(/audit_events/);
  });
});

describe("a store that cannot do this still works", () => {
  it("refuses to build a store-backed sink over a store without the capability", () => {
    expect(() => storeAudit(new InMemoryStore() as never)).toThrow(/does not keep an audit table/i);
  });

  it("leaves the JSONL path exactly as it was for a store without the capability", async () => {
    const inner = new InMemoryStore();
    const recorded: AuditEvent[] = [];
    const sink: AuditSink = { record: (e) => void recorded.push(e) };
    const governed = govern(inner, { policies: [], context: () => ({ actor: "owner" }), audit: sink });
    const saved = await governed.addNode(node("plain"));
    expect(recorded.some((e) => e.outcome === "allowed" && e.nodeIds.includes(saved.nodeId))).toBe(true);
  });
});

describe("an existing store opens and keeps working", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "al-buddy-audit-migrate-"));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("adds the table to a database written before it existed, without touching the facts", async () => {
    const dbPath = join(dir, "legacy.db");
    const before = new SqliteMemoryStore(dbPath);
    const kept = await before.addNode(node("written before the audit table existed"));
    before.close();

    // Rewind to the schema version before audit_events and drop the table, which
    // is exactly what a 0.4.2 file looks like.
    const db = new Database(dbPath);
    db.prepare(`DROP TABLE IF EXISTS audit_events`).run();
    db.pragma("user_version = 6");
    db.close();

    const reopened = new SqliteMemoryStore(dbPath);
    try {
      expect((await reopened.getNode(kept.nodeId))?.content.text).toBe("written before the audit table existed");
      // Ungoverned, with no sink: the table exists and stays empty. Nothing is
      // adopted from any JSONL log — the two chains cover different periods and
      // neither can attest to the other's.
      await reopened.addNode(node("after the upgrade"));
      expect(rows(dbPath)).toHaveLength(0);
    } finally {
      reopened.close();
    }
  });
});
