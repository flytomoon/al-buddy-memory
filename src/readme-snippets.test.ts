import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");
const readme = readFileSync(join(root, "README.md"), "utf8");
const blocks = [...readme.matchAll(/^```(\w+)\n([\s\S]*?)^```/gm)].map((m) => ({ language: m[1], code: m[2]!, line: readme.slice(0, m.index).split("\n").length }));

describe("README fenced examples", () => {
  it("parses every JSON example and checks every shell example's syntax", () => {
    expect(blocks.length).toBeGreaterThan(0);
    let attempted = 0;
    let succeeded = 0;
    for (const block of blocks) {
      if (block.language === "json") {
        attempted++;
        expect(() => JSON.parse(block.code), `README line ${block.line}`).not.toThrow();
        succeeded++;
      } else if (block.language === "sh") {
        attempted++;
        const check = spawnSync("sh", ["-n"], { input: block.code, encoding: "utf8" });
        expect(check.status, `README line ${block.line}: ${check.stderr}`).toBe(0);
        succeeded++;
      }
    }
    expect(succeeded).toBe(attempted);
    expect(succeeded).toBeGreaterThan(0);
  });

  it("executes every TypeScript example against the built package", () => {
    const examples = blocks.filter((block) => block.language === "ts");
    expect(examples.length).toBeGreaterThan(0);
    let attempted = 0;
    let succeeded = 0;
    for (const block of examples) {
      attempted++;
      const dir = mkdtempSync(join(tmpdir(), "readme-snippet-"));
      try {
        const js = ts.transpileModule(block.code, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
          .replaceAll('from "al-buddy-memory"', `from "${pathToFileURL(join(root, "dist", "index.js")).href}"`);
        const file = join(dir, "example.mjs");
        writeFileSync(file, js);
        const run = spawnSync(process.execPath, [file], { cwd: dir, encoding: "utf8", timeout: 30_000 });
        expect(run.status, `README line ${block.line}: ${run.stderr}`).toBe(0);
        succeeded++;
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    expect(succeeded).toBe(attempted);
  });
});
