import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { build } from "esbuild";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { legacyProjectDbPath } from "./project-memory.js";
import { SqliteMemoryStore, readRecordedScope } from "./sqlite-memory-store.js";

/**
 * GPT-6-Astra, re-reviewing the merged 0.4.2 work on 2026-09-19: claiming a
 * scope read the stamp and then wrote it, with nothing holding the two
 * together. Two processes that both looked at an unstamped 0.4.1 file before
 * either wrote both claimed it, `INSERT OR REPLACE` let the second overwrite
 * the first, and the two scopes went on sharing one database — recalling each
 * other's private facts, which is the very failure (R1) the stamp exists to
 * stop. Inside one process the read and the write cannot be interleaved, so
 * this takes two real ones.
 *
 * The children park between the read and the write — on the statement that
 * records the stamp, after the one that looked for it. That is the window. A
 * read-then-write claim lets both children stand in it; a claim that is one
 * `BEGIN IMMEDIATE` transaction does not, because the first child is holding
 * the write lock while it waits and the second cannot get that far. So the
 * parent releases the barrier once both are inside it OR once it is clear only
 * one ever will be, and the assertion is that exactly one process wins.
 */

const here = dirname(fileURLToPath(import.meta.url));

/** The child: our real store, opened under a scope, with a barrier in the claim. */
const CHILD = `
import Database from "better-sqlite3";
import { existsSync, writeFileSync } from "node:fs";

import { SqliteMemoryStore } from "./sqlite-memory-store.js";

const [dbPath, scope, id, dir] = process.argv.slice(2);

let parked = false;
function park() {
  if (parked) return;
  parked = true;
  writeFileSync(dir + "/ready-" + id, "");
  const until = Date.now() + 10000;
  // The store's constructor is synchronous, so the wait has to be too.
  while (!existsSync(dir + "/go") && Date.now() < until) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
}

const prepare = Database.prototype.prepare;
Database.prototype.prepare = function (sql) {
  const stmt = prepare.call(this, sql);
  // The stamp has been looked for and is about to be written: the window.
  if (!/^\\s*INSERT[\\s\\S]*memory_meta/i.test(sql)) return stmt;
  const original = stmt.run;
  stmt.run = function (...args) {
    park();
    return original.apply(this, args);
  };
  return stmt;
};

try {
  const store = new SqliteMemoryStore(dbPath, { scope });
  await store.addNode({
    provenance: "UserInput", encryptionKeyRef: "local", memoryType: "Conversation",
    privacyClassification: "Private", retentionTier: "FullRetention",
    content: { text: "a private fact from " + id },
    contextualMetadata: {}, confidenceWeight: 1, decayRate: 0,
  });
  const facts = (await store.searchNodes({ query: "private" })).map((n) => n.content.text);
  store.close();
  console.log(JSON.stringify({ id, scope, opened: true, facts }));
} catch (err) {
  console.log(JSON.stringify({ id, scope, opened: false, error: err instanceof Error ? err.message : String(err) }));
}
`;

interface ChildResult {
  id: string;
  scope: string;
  opened: boolean;
  facts?: string[];
  error?: string;
}

const run = promisify(execFile);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("claiming a scope is one step, across processes", () => {
  let rig: string;
  let child: string;
  let dir: string;

  beforeAll(async () => {
    // The child has to be a real process running the real store, so the source
    // is bundled once. `better-sqlite3` is a native addon and stays external —
    // the symlink is how the child resolves it.
    rig = mkdtempSync(join(tmpdir(), "al-buddy-claim-rig-"));
    symlinkSync(resolve(here, "..", "node_modules"), join(rig, "node_modules"), "dir");
    child = join(rig, "claim-child.mjs");
    await build({
      stdin: { contents: CHILD, resolveDir: here, loader: "ts", sourcefile: "claim-child.ts" },
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node20",
      external: ["better-sqlite3", "@huggingface/transformers", "@modelcontextprotocol/sdk", "zod"],
      outfile: child,
      logLevel: "silent",
    });
  }, 60_000);

  afterAll(() => rmSync(rig, { recursive: true, force: true }));

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "al-buddy-claim-race-"));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("lets exactly one of two processes claim an unstamped store (the re-review's repro)", async () => {
    // What 0.4.1 left behind: a migrated database with no scope recorded in it.
    const dbPath = legacyProjectDbPath("org/repo", dir);
    new SqliteMemoryStore(dbPath).close();

    const start = (scope: string, id: string) =>
      run(process.execPath, [child, dbPath, scope, id, dir], { encoding: "utf8" }).then(
        (r) => JSON.parse(r.stdout.trim()) as ChildResult,
        (e: { stdout?: string }) => JSON.parse(String(e.stdout ?? "{}").trim()) as ChildResult,
      );

    const both = Promise.all([start("org/repo", "1"), start("org-repo", "2")]);

    // Release once both are inside the claim — or, when only one can be, once
    // waiting any longer proves nothing.
    const until = Date.now() + 800;
    while (Date.now() < until && !(existsSync(join(dir, "ready-1")) && existsSync(join(dir, "ready-2")))) await sleep(10);
    writeFileSync(join(dir, "go"), "");

    const results = await both;
    const opened = results.filter((r) => r.opened);
    const refused = results.filter((r) => !r.opened);

    // THE DEFECT at cce9cf9: both opened, and each then read the other's facts.
    expect(opened).toHaveLength(1);
    expect(refused[0]?.error).toMatch(/holds the scope/);
    expect(opened[0]?.facts).toEqual([`a private fact from ${opened[0]!.id}`]);
    expect(readRecordedScope(dbPath)).toBe(opened[0]?.scope);
  }, 30_000);

  it("keeps letting the same scope back into the file it claimed", async () => {
    const dbPath = legacyProjectDbPath("org/repo", dir);
    const first = new SqliteMemoryStore(dbPath, { scope: "org/repo" });
    first.close();
    const again = new SqliteMemoryStore(dbPath, { scope: "org/repo" });
    again.close();
    expect(readRecordedScope(dbPath)).toBe("org/repo");
    expect(() => new SqliteMemoryStore(dbPath, { scope: "org-repo" })).toThrow(/holds the scope/);
  });
});
