import Database from "better-sqlite3";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { build } from "esbuild";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { verifyAuditLogs, type AuditEvent } from "./audit.js";
import { AUDIT_EVENTS_SCHEMA, verifyAuditTable } from "./audit-table.js";

/**
 * B1 and C2 in docs/RESILIENCE-LEDGER.md. A chained JSONL log has exactly one
 * writer: two processes appending to one file read the same head and fork the
 * chain, so 0.4.2 gave each process its own file — and paid for it with a set
 * that has no manifest, where deleting a whole file leaves the rest verifying
 * clean.
 *
 * One table inside the database is one chain with many writers, because the
 * tail is read and extended inside the same `BEGIN IMMEDIATE` transaction as
 * the fact. Two processes cannot both read the same tail; SQLite's write lock
 * makes the appends a total order. This takes two real processes to show.
 */

const here = dirname(fileURLToPath(import.meta.url));

/**
 * The children must actually overlap, or this proves nothing: spawning two Node
 * processes takes long enough that the first finishes before the second starts,
 * and a chain head cached per process — the very defect — then passes. Verified
 * by sabotage on 2026-09-19: with a cached head and no barrier the test was
 * green. So both children park on a barrier and are released together.
 */
const CHILD = `
import { existsSync, writeFileSync } from "node:fs";

import { SqliteMemoryStore } from "../sqlite-memory-store.js";
import { govern, storeAudit } from "./index.js";

const [dbPath, actor, countText, dir] = process.argv.slice(2);
const count = Number(countText);

const store = new SqliteMemoryStore(dbPath);
const governed = govern(store, { policies: [], context: () => ({ actor }), audit: storeAudit(store) });

// Everything expensive is done; wait for the other process to be here too.
writeFileSync(dir + "/ready-" + actor, "");
const until = Date.now() + 20000;
while (!existsSync(dir + "/go") && Date.now() < until) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
}

const errors = [];
for (let i = 0; i < count; i++) {
  try {
    await governed.addNode({
      provenance: "UserInput", encryptionKeyRef: "local", memoryType: "Experience",
      privacyClassification: "Private", retentionTier: "FullRetention",
      content: { text: actor + " fact " + i },
      contextualMetadata: {}, confidenceWeight: 1, decayRate: 0,
    });
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  }
  // Let go of the write lock between facts. Without this SQLite's busy wait
  // starves the second process until the first has finished, and the two
  // "concurrent" writers are really two consecutive ones — which a chain head
  // cached per process survives, so the test would prove nothing.
  await new Promise((r) => setTimeout(r, 1 + Math.floor(Math.random() * 4)));
}
store.close();
console.log(JSON.stringify({ actor, written: count - errors.length, errors }));
`;

/**
 * `addNode` starts with a write, so it takes the write lock immediately whether
 * the transaction was opened IMMEDIATE or DEFERRED — which is why the whole
 * suite passed with `.deferred()` when that was tried on 2026-09-19. `updateNode`
 * reads first, so a DEFERRED transaction has to upgrade mid-flight, and under
 * contention the upgrade fails: measured, 15-20% of writes are lost to
 * "database is locked". This child is the one that can tell the two apart.
 */
const UPDATE_CHILD = `
import { existsSync, writeFileSync } from "node:fs";

import { SqliteMemoryStore } from "../sqlite-memory-store.js";
import { govern, storeAudit } from "./index.js";

const [dbPath, actor, countText, dir, nodeId] = process.argv.slice(2);
const count = Number(countText);

const store = new SqliteMemoryStore(dbPath);
const governed = govern(store, { policies: [], context: () => ({ actor }), audit: storeAudit(store) });

writeFileSync(dir + "/ready-" + actor, "");
const until = Date.now() + 20000;
while (!existsSync(dir + "/go") && Date.now() < until) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
}

const errors = [];
for (let i = 0; i < count; i++) {
  try {
    await governed.updateNode(nodeId, { confidenceWeight: (i % 9) / 10 + 0.1 });
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  }
  await new Promise((r) => setTimeout(r, 1 + Math.floor(Math.random() * 4)));
}
store.close();
console.log(JSON.stringify({ actor, written: count - errors.length, errors }));
`;

/**
 * A writer that keeps appending until a stop file appears, so the parent can
 * verify the chain WHILE it is being extended. Nothing about the trail is being
 * deleted here; that is the point.
 */
const APPENDER_CHILD = `
import { existsSync, writeFileSync } from "node:fs";

import { SqliteMemoryStore } from "../sqlite-memory-store.js";
import { govern, storeAudit } from "./index.js";

const [dbPath, dir] = process.argv.slice(2);
const store = new SqliteMemoryStore(dbPath);
const governed = govern(store, { policies: [], context: () => ({ actor: "writer" }), audit: storeAudit(store) });

writeFileSync(dir + "/ready-writer", "");
let n = 0;
while (!existsSync(dir + "/stop")) {
  await governed.addNode({
    provenance: "UserInput", encryptionKeyRef: "local", memoryType: "Experience",
    privacyClassification: "Private", retentionTier: "FullRetention",
    content: { text: "fact " + n++ },
    contextualMetadata: {}, confidenceWeight: 1, decayRate: 0,
  });
  await new Promise((r) => setTimeout(r, 2));
}
store.close();
console.log(JSON.stringify({ actor: "writer", written: n, errors: [] }));
`;

interface ChildResult {
  actor: string;
  written: number;
  errors: string[];
}

const run = promisify(execFile);

describe("two processes, one chain", () => {
  let rig: string;
  let child: string;
  let updateChild: string;
  let appenderChild: string;
  let dir: string;

  beforeAll(async () => {
    rig = mkdtempSync(join(tmpdir(), "al-buddy-audit-rig-"));
    symlinkSync(resolve(here, "..", "..", "node_modules"), join(rig, "node_modules"), "dir");
    child = join(rig, "audit-child.mjs");
    updateChild = join(rig, "audit-update-child.mjs");
    const compile = (contents: string, outfile: string, name: string): Promise<unknown> =>
      build({
        stdin: { contents, resolveDir: here, loader: "ts", sourcefile: name },
        bundle: true,
        format: "esm",
        platform: "node",
        target: "node20",
        external: ["better-sqlite3", "@huggingface/transformers", "@modelcontextprotocol/sdk", "zod"],
        outfile,
        logLevel: "silent",
      });
    appenderChild = join(rig, "audit-appender-child.mjs");
    await Promise.all([
      compile(CHILD, child, "audit-child.ts"),
      compile(UPDATE_CHILD, updateChild, "audit-update-child.ts"),
      compile(APPENDER_CHILD, appenderChild, "audit-appender-child.ts"),
    ]);
  }, 60_000);

  afterAll(() => rmSync(rig, { recursive: true, force: true }));

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "al-buddy-audit-cross-"));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("cannot be forked by two processes writing at once", async () => {
    const dbPath = join(dir, "memory.db");
    const each = 20;

    const start = (actor: string): Promise<ChildResult> =>
      run(process.execPath, [child, dbPath, actor, String(each), dir], { encoding: "utf8" }).then(
        (r) => JSON.parse(r.stdout.trim()) as ChildResult,
        (e: { stdout?: string; stderr?: string }) => {
          throw new Error(`child failed: ${String(e.stderr ?? "")} ${String(e.stdout ?? "")}`);
        },
      );

    const both = Promise.all([start("alice"), start("bob")]);
    // Release only once both are at the barrier, so the writes really interleave.
    const until = Date.now() + 15_000;
    while (Date.now() < until && !(existsSync(join(dir, "ready-alice")) && existsSync(join(dir, "ready-bob")))) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(existsSync(join(dir, "ready-alice")) && existsSync(join(dir, "ready-bob")), "the children never reached the barrier; this proves nothing about concurrency").toBe(true);
    writeFileSync(join(dir, "go"), "");

    const results = await both;
    // If the children could not write at all, the assertions below would read as
    // a claim about the chain rather than about a broken rig.
    for (const r of results) expect(r.written, `${r.actor} wrote nothing: ${r.errors.join("; ")}`).toBeGreaterThan(0);

    const db = new Database(dbPath, { readonly: true });
    const chain = (db.prepare(`SELECT seq, prev, hash, event FROM audit_events ORDER BY seq`).all() as { seq: number; prev: string; hash: string; event: string }[]).map((r) => ({
      ...r,
      parsed: JSON.parse(r.event) as AuditEvent,
    }));
    db.close();

    const written = results.reduce((n, r) => n + r.written, 0);
    // Both processes are in ONE chain, in one total order. A forked chain shows
    // up as two records carrying the same `prev`.
    expect(chain).toHaveLength(written);
    expect(new Set(chain.map((r) => r.prev)).size).toBe(chain.length);
    for (let i = 1; i < chain.length; i++) expect(chain[i]!.prev).toBe(chain[i - 1]!.hash);
    expect(new Set(chain.map((r) => r.parsed.actor))).toEqual(new Set(["alice", "bob"]));
    // And they really interleaved. One switch would mean two consecutive blocks,
    // which is not concurrency and would let the defect through (see above).
    const switches = chain.filter((r, i) => i > 0 && r.parsed.actor !== chain[i - 1]!.parsed.actor).length;
    expect(switches, `the writers did not interleave (${switches} switch(es) in ${chain.length} events); this proves nothing`).toBeGreaterThan(1);

    // And the shipped verifier agrees, in one call, over one chain.
    const checked = await verifyAuditLogs(dbPath);
    expect(checked.ok, JSON.stringify(checked)).toBe(true);
    expect(checked.logs).toHaveLength(1);
    const result = checked.logs[0]!.result;
    expect(result.ok && result.count).toBe(written);
  }, 60_000);

  /**
   * The guard on `mutation()`'s `.immediate()`.
   *
   * Switched to `.deferred()` the entire suite still passed, because the only
   * mutation raced anywhere was `addNode` — whose first statement is a write, so
   * it takes the lock either way. A read-then-write mutation is what tells them
   * apart: DEFERRED has to upgrade to a write lock it did not hold, and under
   * contention 15-20% of the upgrades fail and those writes are lost (measured,
   * 2026-09-19). The chain stays sound either way, which is why the comment on
   * `mutation()` used to overstate this as "not a chain" — the real cost is
   * dropped writes, and it is silent.
   *
   * So this asserts the thing a caller actually cares about: every update that
   * was asked for landed.
   */
  /**
   * The tail check reads three things — how many events, the rows, the
   * high-water mark. As three separate statements they are three different
   * moments, and an append landing between them leaves the mark ahead of the
   * rows: the exact signature of a deleted tail. It then refuses a healthy
   * store, because the same check gates the first append.
   *
   * Nothing is deleted anywhere in this test. Every failure it can produce is
   * a false accusation.
   */
  it("does not accuse a chain that is being extended while it is read", async () => {
    const dbPath = join(dir, "memory.db");

    // A chain long enough that the walk takes real time; the race window is the
    // walk. Seeded directly so the test does not spend a minute writing facts.
    const { chainDigest, GENESIS } = await import("./chain.js");
    const seed = new Database(dbPath);
    seed.pragma("journal_mode = WAL");
    for (const stmt of AUDIT_EVENTS_SCHEMA) seed.exec(stmt);
    const insert = seed.prepare(`INSERT INTO audit_events (prev, hash, event) VALUES (?, ?, ?)`);
    let prev = GENESIS;
    seed.transaction(() => {
      for (let i = 0; i < 20_000; i++) {
        const event = { at: new Date().toISOString(), actor: "seed", audience: "self", purpose: "recall", outcome: "allowed", nodeIds: [`n${i}`], count: 1 };
        const hash = chainDigest(prev, event, undefined);
        insert.run(prev, hash, JSON.stringify(event));
        prev = hash;
      }
    })();
    seed.close();

    const writer = run(process.execPath, [appenderChild, dbPath, dir], { encoding: "utf8" }).then(
      (r) => JSON.parse(r.stdout.trim()) as ChildResult,
      (e: { stdout?: string; stderr?: string }) => {
        throw new Error(`child failed: ${String(e.stderr ?? "")} ${String(e.stdout ?? "")}`);
      },
    );
    const until = Date.now() + 15_000;
    while (Date.now() < until && !existsSync(join(dir, "ready-writer"))) await new Promise((r) => setTimeout(r, 10));
    expect(existsSync(join(dir, "ready-writer")), "the writer never started; this proves nothing").toBe(true);

    const failures: string[] = [];
    for (let i = 0; i < 12; i++) {
      const checked = await verifyAuditTable(dbPath);
      if (!checked.ok) failures.push(checked.reason);
    }
    writeFileSync(join(dir, "stop"), "");
    const result = await writer;

    expect(result.written, "the writer never appended, so nothing was concurrent").toBeGreaterThan(0);
    expect(failures, `verify accused a chain nobody deleted from: ${failures.slice(0, 2).join(" | ")}`).toEqual([]);
  }, 60_000);

  it("loses no writer's update under contention (the guard on IMMEDIATE)", async () => {
    const dbPath = join(dir, "memory.db");
    const each = 15;

    const { SqliteMemoryStore } = await import("../sqlite-memory-store.js");
    const seed = new SqliteMemoryStore(dbPath);
    const target = await seed.addNode({
      provenance: "UserInput", encryptionKeyRef: "local", memoryType: "Experience",
      privacyClassification: "Private", retentionTier: "FullRetention",
      content: { text: "the fact both processes keep re-weighting" },
      contextualMetadata: {}, confidenceWeight: 1, decayRate: 0,
    });
    seed.close();

    const start = (actor: string): Promise<ChildResult> =>
      run(process.execPath, [updateChild, dbPath, actor, String(each), dir, target.nodeId], { encoding: "utf8" }).then(
        (r) => JSON.parse(r.stdout.trim()) as ChildResult,
        (e: { stdout?: string; stderr?: string }) => {
          throw new Error(`child failed: ${String(e.stderr ?? "")} ${String(e.stdout ?? "")}`);
        },
      );

    const both = Promise.all([start("alice"), start("bob")]);
    const until = Date.now() + 15_000;
    while (Date.now() < until && !(existsSync(join(dir, "ready-alice")) && existsSync(join(dir, "ready-bob")))) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(existsSync(join(dir, "ready-alice")) && existsSync(join(dir, "ready-bob")), "the children never reached the barrier; this proves nothing about concurrency").toBe(true);
    writeFileSync(join(dir, "go"), "");

    const results = await both;
    // The assertion. Not "the chain is sound" — it is, under both — but that
    // nobody's write was silently dropped.
    for (const r of results) {
      expect(r.written, `${r.actor} lost ${each - r.written} of ${each} updates: ${r.errors.join("; ")}`).toBe(each);
    }

    const checked = await verifyAuditLogs(dbPath);
    expect(checked.ok, JSON.stringify(checked)).toBe(true);
  }, 60_000);
});
