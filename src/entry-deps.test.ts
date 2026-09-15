import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * `npm install al-buddy-memory --omit=optional` must still give you a library.
 * The main entry re-exported the MCP module, which statically imports optional
 * `zod`, so importing even InMemoryStore failed without it (review 2026-09-14).
 * This walks every static import reachable from the entry and fails on any
 * optional dependency. Dynamic `await import()` (the local embedder) is fine:
 * it only loads when used.
 */
const root = join(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { optionalDependencies?: Record<string, string>; exports: Record<string, { import: string }> };
const optional = Object.keys(pkg.optionalDependencies ?? {});

function staticImports(file: string): string[] {
  const src = readFileSync(file, "utf8");
  const out: string[] = [];
  // `import … from "x"` and `export … from "x"`, but not `import type` / `export type`.
  for (const m of src.matchAll(/^\s*(?:import|export)\s+(?!type\b)[^;]*?from\s+["']([^"']+)["']/gm)) out.push(m[1]!);
  for (const m of src.matchAll(/^\s*import\s+["']([^"']+)["']/gm)) out.push(m[1]!);
  return out;
}

function reachable(entry: string): { files: Set<string>; packages: Set<string> } {
  const files = new Set<string>();
  const packages = new Set<string>();
  const visit = (file: string) => {
    if (files.has(file)) return;
    files.add(file);
    for (const spec of staticImports(file)) {
      if (spec.startsWith(".")) visit(resolve(dirname(file), spec.replace(/\.js$/, ".ts")));
      else if (!spec.startsWith("node:")) packages.add(spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]!);
    }
  };
  visit(entry);
  return { files, packages };
}

describe("the main entry", () => {
  it("imports no optional dependency, however deep", () => {
    const { files, packages } = reachable(join(root, "src", "index.ts"));
    expect(files.size).toBeGreaterThan(10); // the walk really walked
    expect([...packages].filter((p) => optional.includes(p))).toEqual([]);
  });

  it("still publishes the MCP server at its own subpath", () => {
    expect(pkg.exports["./mcp"]?.import).toBe("./dist/mcp/governance-server.js");
  });
});
