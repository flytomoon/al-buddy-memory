import Database from "better-sqlite3";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { makeNode } from "./memory-store-conformance.spec.js";
import { SCHEMA_VERSION, SqliteMemoryStore } from "./sqlite-memory-store.js";

describe("SQLite transaction history", () => {
  it("rolls the node update and anchor back when the version insert fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "al-buddy-history-atomic-"));
    const path = join(dir, "memory.db");
    try {
      const store = new SqliteMemoryStore(path);
      const fact = await store.addNode(makeNode());
      const raw = new Database(path);
      raw.exec(`CREATE TRIGGER stop_version BEFORE INSERT ON node_versions BEGIN SELECT RAISE(ABORT, 'version refused'); END`);
      raw.close();
      await expect(store.updateNode(fact.nodeId, { confidenceWeight: 0.2 })).rejects.toThrow(/version refused/);
      expect(await store.getNode(fact.nodeId)).toEqual(fact);
      expect(await store.history(fact.nodeId)).toEqual([]);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("cascades versions on erasure with foreign keys enabled", async () => {
    const dir = mkdtempSync(join(tmpdir(), "al-buddy-history-cascade-"));
    const path = join(dir, "memory.db");
    try {
      const store = new SqliteMemoryStore(path);
      const fact = await store.addNode(makeNode());
      await store.updateNode(fact.nodeId, { confidenceWeight: 0.2 });
      await store.deleteNode(fact.nodeId);
      store.close();
      const raw = new Database(path, { readonly: true });
      expect((raw.prepare(`SELECT count(*) AS n FROM node_versions WHERE node_id = ?`).get(fact.nodeId) as { n: number }).n).toBe(0);
      raw.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("migrates a v7 database without inventing missing history", async () => {
    const dir = mkdtempSync(join(tmpdir(), "al-buddy-history-v7-"));
    const path = join(dir, "memory.db");
    try {
      const seed = new SqliteMemoryStore(path);
      const fact = await seed.addNode(makeNode());
      seed.close();
      const raw = new Database(path);
      raw.exec(`DROP TABLE node_versions`);
      raw.prepare(`UPDATE memory_nodes SET temporal_anchors = ?, created_at = ?, valid_from = ? WHERE node_id = ?`).run(JSON.stringify([
        { timestamp: "2026-01-01T00:00:00.000Z", event: "created" },
        { timestamp: "2026-03-01T00:00:00.000Z", event: "modified" },
      ]), "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z", fact.nodeId);
      raw.pragma("user_version = 7");
      raw.close();

      const migrated = new SqliteMemoryStore(path);
      expect((await migrated.getNode(fact.nodeId))?.content.text).toBe(fact.content.text);
      expect((await migrated.snapshotAsOf("2026-02-01T00:00:00Z")).inexact).toContain(fact.nodeId);
      migrated.close();
      const checked = new Database(path);
      expect(checked.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
      checked.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

const here = dirname(fileURLToPath(import.meta.url));
const CHILD = `
import { existsSync, writeFileSync } from "node:fs";
import { SqliteMemoryStore } from "./sqlite-memory-store.js";
const [path, name, nodeId, dir] = process.argv.slice(2);
const store = new SqliteMemoryStore(path);
writeFileSync(dir + "/ready-" + name, "");
while (!existsSync(dir + "/go")) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
for (let i = 0; i < 10; i++) {
  await store.updateNode(nodeId, { confidenceWeight: ((i + (name === "a" ? 0 : 1)) % 9 + 1) / 10 });
  await new Promise((resolve) => setTimeout(resolve, 1 + Math.floor(Math.random() * 3)));
}
store.close();
`;

describe("SQLite history across processes", () => {
  let rig: string;
  let child: string;
  beforeAll(async () => {
    rig = mkdtempSync(join(tmpdir(), "al-buddy-history-rig-"));
    symlinkSync(resolve(here, "..", "node_modules"), join(rig, "node_modules"), "dir");
    child = join(rig, "child.mjs");
    await build({ stdin: { contents: CHILD, resolveDir: here, loader: "ts" }, bundle: true, format: "esm", platform: "node", target: "node24", external: ["better-sqlite3"], outfile: child, logLevel: "silent" });
  });
  afterAll(() => rmSync(rig, { recursive: true, force: true }));

  it("serialises two real writers into one unbroken version chain", async () => {
    const dir = mkdtempSync(join(tmpdir(), "al-buddy-history-process-"));
    try {
      const path = join(dir, "memory.db");
      const seed = new SqliteMemoryStore(path);
      const fact = await seed.addNode(makeNode());
      seed.close();
      const run = promisify(execFile);
      const start = (name: string) => run(process.execPath, [child, path, name, fact.nodeId, dir]);
      const both = Promise.all([start("a"), start("b")]);
      const until = Date.now() + 10_000;
      while (Date.now() < until && !(existsSync(join(dir, "ready-a")) && existsSync(join(dir, "ready-b")))) await new Promise((resolve) => setTimeout(resolve, 10));
      expect(existsSync(join(dir, "ready-a")) && existsSync(join(dir, "ready-b"))).toBe(true);
      writeFileSync(join(dir, "go"), "");
      await both;
      const store = new SqliteMemoryStore(path);
      const versions = await store.history(fact.nodeId);
      expect(versions).toHaveLength(20);
      for (let i = 0; i + 1 < versions.length; i++) expect(versions[i]!.after).toEqual(versions[i + 1]!.before);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
