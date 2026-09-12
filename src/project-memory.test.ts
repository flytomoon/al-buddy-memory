import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProjectMemory, projectDbPath } from "./project-memory.js";

describe("projectDbPath", () => {
  it("puts each project in its own file under the base dir", () => {
    expect(projectDbPath("al-buddy", "/base")).toBe("/base/al-buddy.db");
  });

  it("sanitizes unsafe characters in the project name", () => {
    expect(projectDbPath("../evil/project", "/base")).toBe("/base/---evil-project.db");
  });
});

describe("ProjectMemory", () => {
  let baseDir: string;

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), "al-buddy-projmem-"));
  });

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  it("captures a memory and recalls it by search", async () => {
    const mem = new ProjectMemory("al-buddy", { baseDir });
    try {
      await mem.capture({ text: "chose SQLite for the memory store", tags: ["decision"] });
      const hits = await mem.recall("SQLite");
      expect(hits).toHaveLength(1);
      expect(hits[0]?.content.text).toContain("SQLite");
    } finally {
      mem.close();
    }
  });

  it("persists memories across separate instances (survives restart)", async () => {
    const first = new ProjectMemory("al-buddy", { baseDir });
    await first.capture({ text: "the flattening insight" });
    first.close();

    const second = new ProjectMemory("al-buddy", { baseDir });
    try {
      const hits = await second.recall("flattening");
      expect(hits).toHaveLength(1);
    } finally {
      second.close();
    }
  });

  it("keeps projects siloed from each other", async () => {
    const albuddy = new ProjectMemory("al-buddy", { baseDir });
    const beta = new ProjectMemory("beta", { baseDir });
    try {
      await albuddy.capture({ text: "al-buddy secret" });
      const leak = await beta.recall("secret");
      expect(leak).toHaveLength(0);
    } finally {
      albuddy.close();
      beta.close();
    }
  });

  it("renders an empty memory block for a fresh project", async () => {
    const mem = new ProjectMemory("fresh-project", { baseDir });
    try {
      const block = await mem.renderBlock();
      expect(block).toContain("fresh-project");
      expect(block.toLowerCase()).toContain("no memories");
    } finally {
      mem.close();
    }
  });

  it("renders captured memories into the block", async () => {
    const mem = new ProjectMemory("al-buddy", { baseDir });
    try {
      await mem.capture({ text: "wedge: a build companion that never forgets", type: "Belief" });
      const block = await mem.renderBlock();
      expect(block).toContain("al-buddy");
      expect(block).toContain("build companion that never forgets");
    } finally {
      mem.close();
    }
  });

  it("excludes superseded (invalidated) facts from the block", async () => {
    const mem = new ProjectMemory("al-buddy", { baseDir });
    try {
      const node = await mem.capture({ text: "currently using Postgres" });
      // Supersede it: no longer true as of now.
      await mem.supersede(node.nodeId);
      const block = await mem.renderBlock();
      expect(block).not.toContain("currently using Postgres");
    } finally {
      mem.close();
    }
  });
});
