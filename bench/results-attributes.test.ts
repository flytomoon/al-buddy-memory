import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Benchmark results stay out of a branch's diff (.gitattributes). Jobs #1003
 * and #1004 committed 50-question sweeps of 1-2 MB each beside their code; the
 * landing review was handed a 4.8 MB and a 5.6 MB diff, 98% result rows, and
 * held both. With `-diff` the same diff is 100 KB and lists each result as
 * "Bin 0 -> N bytes". A summary file stays in the diff: it is a few lines the
 * docs' numbers are checked against.
 *
 * The first test reads .gitattributes and runs anywhere; the second asks git
 * about every committed result file and skips where git cannot run.
 */
const root = join(dirname(new URL(import.meta.url).pathname), "..");
const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

/** Whether a result file at this path should be left out of diffs. */
const isRowData = (path: string) => /^bench\/results\/[^/]+\.jsonl?$/.test(path) && !path.endsWith(".summary.json");

describe("bench results — data, not diff", () => {
  it(".gitattributes leaves result rows out of diffs and keeps summaries in", () => {
    const lines = readFileSync(join(root, ".gitattributes"), "utf8").split("\n").map((l) => l.trim());
    expect(lines).toContain("bench/results/*.json -diff linguist-generated=true");
    expect(lines).toContain("bench/results/*.jsonl -diff linguist-generated=true");
    // Later lines win in .gitattributes: the summary override has to come after the *.json line.
    const json = lines.indexOf("bench/results/*.json -diff linguist-generated=true");
    const summary = lines.indexOf("bench/results/*.summary.json diff -linguist-generated");
    expect(summary).toBeGreaterThan(json);
    // Merges of result files stay textual; only the diff is suppressed.
    expect(lines.filter((l) => l.startsWith("bench/results/")).join("\n")).not.toMatch(/\bbinary\b|-merge\b/);
  });

  it("git shows every committed result file as data and every summary as text", (ctx) => {
    let files: string[];
    try {
      files = git("ls-files", "bench/results").split("\n").filter(Boolean);
    } catch {
      ctx.skip();
      return;
    }
    expect(files.some(isRowData)).toBe(true);
    const attrs = git("check-attr", "diff", "--", ...files);
    for (const file of files) {
      const value = attrs.match(new RegExp(`^${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: diff: (\\S+)$`, "m"))?.[1];
      expect(value, file).toBe(isRowData(file) ? "unset" : file.endsWith(".summary.json") ? "set" : "unspecified");
    }
  });
});
