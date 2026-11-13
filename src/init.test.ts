import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const bin = join(import.meta.dirname, "..", "bin", "al-buddy-memory.js");

describe("init", () => {
  it("creates a local memory and preserves Cursor's other servers across reruns", () => {
    const home = mkdtempSync(join(tmpdir(), "memory-init-"));
    try {
      const cursor = join(home, ".cursor");
      mkdirSync(cursor);
      writeFileSync(join(cursor, "mcp.json"), JSON.stringify({ mcpServers: { other: { command: "other" } } }));
      const env = { ...process.env, HOME: home, PATH: "" };
      for (let runNumber = 0; runNumber < 2; runNumber++) {
        const run = spawnSync(process.execPath, [bin, "init"], { env, encoding: "utf8", timeout: 30_000 });
        expect(run.status, run.stderr).toBe(0);
        expect(run.stdout).toMatch(/RESULT: 1\/3 client configurations ready/);
      }
      const config = JSON.parse(readFileSync(join(cursor, "mcp.json"), "utf8"));
      expect(config.mcpServers.other).toEqual({ command: "other" });
      expect(config.mcpServers["al-buddy-memory"].env.AL_BUDDY_MEMORY_SEMANTIC).toBe("off");
      expect(readFileSync(join(home, ".al-buddy-memory", "brain.db")).length).toBeGreaterThan(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("reports a malformed Cursor config without replacing it", () => {
    const home = mkdtempSync(join(tmpdir(), "memory-init-bad-"));
    try {
      const cursor = join(home, ".cursor");
      mkdirSync(cursor);
      writeFileSync(join(cursor, "mcp.json"), "not json");
      const run = spawnSync(process.execPath, [bin, "init"], { env: { ...process.env, HOME: home, PATH: "" }, encoding: "utf8", timeout: 30_000 });
      expect(run.status).toBe(1);
      expect(run.stdout).toMatch(/RESULT: 0\/3/);
      expect(readFileSync(join(cursor, "mcp.json"), "utf8")).toBe("not json");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("registers the same keyword-only server with installed Claude Code and Codex CLIs", () => {
    const home = mkdtempSync(join(tmpdir(), "memory-init-clis-"));
    try {
      const mockBin = join(home, "mock-bin");
      mkdirSync(mockBin);
      for (const client of ["claude", "codex"]) {
        const file = join(mockBin, client);
        writeFileSync(file, `#!/bin/sh\nif [ "$2" = get ]; then exit 1; fi\nprintf '%s\\n' "$@" > "$HOME/${client}-args"\n`);
        chmodSync(file, 0o755);
      }
      const run = spawnSync(process.execPath, [bin, "init"], { env: { ...process.env, HOME: home, PATH: mockBin }, encoding: "utf8", timeout: 30_000 });
      expect(run.status, run.stderr).toBe(0);
      expect(run.stdout).toMatch(/RESULT: 3\/3 client configurations ready/);
      for (const client of ["claude", "codex"]) {
        const args = readFileSync(join(home, `${client}-args`), "utf8");
        expect(args).toContain("AL_BUDDY_MEMORY_SEMANTIC=off");
        expect(args).toMatch(/npx\n-y\nal-buddy-memory\nmcp/);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
