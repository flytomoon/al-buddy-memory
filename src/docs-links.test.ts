import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { dirname, join, normalize } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Every relative link in the published docs must resolve (founder, 2026-09-11:
 * the policies' cross-references pointed at files that did not exist). Runs in
 * CI, so a rename can never leave a dangling link behind again.
 */
function markdownFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) markdownFiles(p, out);
    else if (p.endsWith(".md")) out.push(p);
  }
  return out;
}

describe("docs — no dangling relative links", () => {
  it("every [text](relative/path) in README, CONTRIBUTING, SECURITY and docs/ resolves to a file", () => {
    const root = join(dirname(new URL(import.meta.url).pathname), "..");
    const files = [...markdownFiles(join(root, "docs")), ...["README.md", "CONTRIBUTING.md", "SECURITY.md"].map((f) => join(root, f)).filter(existsSync)];
    const broken: string[] = [];
    let checked = 0;
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(/\[[^\]]*\]\(([^)#\s]+)(?:#[^)]*)?\)/g)) {
        const href = m[1]!;
        if (/^(https?:|mailto:)/.test(href)) continue;
        checked += 1;
        if (!existsSync(normalize(join(dirname(file), href)))) broken.push(`${file.replace(root + "/", "")} → ${href}`);
      }
    }
    expect(checked).toBeGreaterThan(20);
    expect(broken).toEqual([]);
  });
});
