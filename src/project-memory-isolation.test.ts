import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ProjectMemory, canonicalProjectDbPath, legacyProjectDbPath, projectDbPath } from "./project-memory.js";
import { SqliteMemoryStore } from "./sqlite-memory-store.js";

/**
 * R1 (release review, 2026-09-18): `projectDbPath` mapped every character
 * outside [a-zA-Z0-9_-] to "-", so "org/repo" and "org-repo" resolved to the
 * same file and one scope recalled the other's private facts — against the
 * isolation the class comment and README promise.
 *
 * The reproduction from the review is the first test below. It fails on 0.4.1.
 */
describe("project scopes are not filename collisions", () => {
  let baseDir: string;

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), "al-buddy-scope-"));
  });

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  it("does not let org-repo recall org/repo's private facts (the review's repro)", async () => {
    const slashed = new ProjectMemory("org/repo", { baseDir });
    const dashed = new ProjectMemory("org-repo", { baseDir });
    try {
      await slashed.capture({ text: "the staging key rotates on Fridays" });
      expect(await dashed.recall("staging key")).toHaveLength(0);
      // …and the scope that wrote it still has it.
      expect(await slashed.recall("staging key")).toHaveLength(1);
    } finally {
      slashed.close();
      dashed.close();
    }
  });

  it("gives names that only differ outside the safe alphabet their own files", () => {
    const names = ["org/repo", "org-repo", "org repo", "org.repo", "org:repo", "órg-repo", "org\\repo"];
    const paths = new Set(names.map((n) => canonicalProjectDbPath(n, baseDir)));
    expect(paths.size).toBe(names.length);
  });

  it("never produces a filename that starts with a dash or leaves a traversal segment", () => {
    for (const name of ["../evil/project", "-rf", "..", "/", "🙂"]) {
      const file = canonicalProjectDbPath(name, baseDir).slice(baseDir.length + 1);
      expect(file.startsWith("-")).toBe(false);
      expect(file).not.toContain("/");
      expect(file).not.toContain("..");
    }
  });

  it("keeps using a store written under the previous filename scheme", async () => {
    // What 0.4.1 wrote for the scope "Al Buddy": a file named by the lossy slug.
    const legacy = legacyProjectDbPath("Al Buddy", baseDir);
    expect(legacy).toBe(join(baseDir, "Al-Buddy.db"));
    const old = new SqliteMemoryStore(legacy);
    await old.addNode({
      provenance: "UserInput", encryptionKeyRef: "local", memoryType: "Lesson",
      privacyClassification: "Private", retentionTier: "FullRetention",
      content: { text: "written before the filename changed" },
      contextualMetadata: {}, confidenceWeight: 1, decayRate: 0,
    });
    old.close();

    const mem = new ProjectMemory("Al Buddy", { baseDir });
    try {
      expect(mem.dbPath).toBe(legacy);
      expect(await mem.recall("filename changed")).toHaveLength(1);
    } finally {
      mem.close();
    }
    // Nothing was moved or copied: still exactly the one database.
    expect(readdirSync(baseDir).filter((f) => f.endsWith(".db"))).toEqual(["Al-Buddy.db"]);
  });

  it("hands the second scope of a colliding pair its own file, once the first has claimed the old one", async () => {
    const shared = legacyProjectDbPath("org/repo", baseDir);
    expect(shared).toBe(legacyProjectDbPath("org-repo", baseDir));
    // What 0.4.1 left behind: one file both scopes were writing into.
    new SqliteMemoryStore(shared).close();

    const first = new ProjectMemory("org/repo", { baseDir });
    expect(first.dbPath).toBe(shared); // an existing store is never stranded
    await first.capture({ text: "belongs to the slashed scope" });
    first.close();

    const second = new ProjectMemory("org-repo", { baseDir });
    try {
      expect(second.dbPath).toBe(canonicalProjectDbPath("org-repo", baseDir));
      expect(await second.recall("slashed scope")).toHaveLength(0);
    } finally {
      second.close();
    }

    // Re-opening the first scope still lands on the file it claimed.
    const again = new ProjectMemory("org/repo", { baseDir });
    try {
      expect(again.dbPath).toBe(shared);
      expect(await again.recall("slashed scope")).toHaveLength(1);
    } finally {
      again.close();
    }
  });

  it("refuses to open a database stamped with a different scope", async () => {
    const mem = new ProjectMemory("org/repo", { baseDir });
    const path = mem.dbPath;
    mem.close();
    expect(() => new SqliteMemoryStore(path, { scope: "someone-else" })).toThrow(/scope/i);
    // …and the rightful scope still opens it.
    const reopened = new SqliteMemoryStore(path, { scope: "org/repo" });
    reopened.close();
  });

  /**
   * The regression the R1 fix introduced, found by GPT-6-Astra re-reviewing the
   * merged result on 2026-09-19. `projectDbPath` returned the canonical path the
   * moment a file existed there, without asking whose it was — and the canonical
   * name `<slug>-<16 hex>` is a name the OLD scheme could also produce, because
   * the old scheme was `<anything in [A-Za-z0-9_-]>.db`. So a 0.4.1 project
   * literally called `foo-2c26b46b68ffc68f` had its database claimed and stamped
   * by the unrelated new scope `foo`, which then recalled its private facts —
   * and the original owner, finding its own file stamped by someone else, was
   * sent to an empty store. No collision in the old scheme was needed.
   */
  it("does not take over a legacy file belonging to a project named like its own new filename", async () => {
    const scope = "foo";
    // The 0.4.1 project whose file lands exactly where `foo`'s canonical file goes.
    const shadowed = basename(canonicalProjectDbPath(scope, baseDir), ".db");
    const theirFile = legacyProjectDbPath(shadowed, baseDir);
    const theirs = new SqliteMemoryStore(theirFile); // no scope recorded: written by 0.4.1
    await theirs.addNode({
      provenance: "UserInput", encryptionKeyRef: "local", memoryType: "Lesson",
      privacyClassification: "Private", retentionTier: "FullRetention",
      content: { text: "a private fact of the other project" },
      contextualMetadata: {}, confidenceWeight: 1, decayRate: 0,
    });
    theirs.close();

    const mine = new ProjectMemory(scope, { baseDir });
    try {
      expect(await mine.recall("private fact")).toHaveLength(0);
    } finally {
      mine.close();
    }

    // …and the project that wrote it still finds it where it left it.
    const owner = new ProjectMemory(shadowed, { baseDir });
    try {
      expect(owner.dbPath).toBe(theirFile);
      expect(await owner.recall("private fact")).toHaveLength(1);
    } finally {
      owner.close();
    }
  });

  it("cannot name a file that the previous scheme could also name", () => {
    // The old scheme's output was `<sanitised>.db`, and sanitising can produce any
    // string over [A-Za-z0-9_-]. So no canonical filename may be spellable that
    // way — otherwise some project's old file is some other project's new one.
    for (const name of ["foo", "x", "org/repo", "Al Buddy", "a.b", "🙂", "-rf"]) {
      const canonical = canonicalProjectDbPath(name, baseDir);
      expect(legacyProjectDbPath(basename(canonical, ".db"), baseDir)).not.toBe(canonical);
    }
  });

  it("resolves an unrecorded legacy file only for the scope that claims it first", () => {
    // projectDbPath is the resolver ProjectMemory uses; it must be stable once claimed.
    const claimed = projectDbPath("org/repo", baseDir);
    const store = new SqliteMemoryStore(claimed, { scope: "org/repo" });
    store.close();
    expect(projectDbPath("org/repo", baseDir)).toBe(claimed);
    expect(projectDbPath("org-repo", baseDir)).toBe(canonicalProjectDbPath("org-repo", baseDir));
    expect(existsSync(claimed)).toBe(true);
  });
});
