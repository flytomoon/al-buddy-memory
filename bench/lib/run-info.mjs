/**
 * What every published benchmark result carries besides its numbers: the code
 * it ran (commit, and whether the tree was clean), the runtime, and a file name
 * that never overwrites an earlier result.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The repository root: two levels above this file. */
export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const RESULTS_DIR = join(REPO_ROOT, "bench", "results");

function git(args, cwd) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

/**
 * Commit, cleanliness, runtime and library version. Read it BEFORE writing any
 * result file, or the result makes its own tree dirty.
 */
export function runInfo(root = REPO_ROOT) {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const status = git(["status", "--porcelain"], root);
  return {
    commit: git(["rev-parse", "HEAD"], root),
    branch: git(["rev-parse", "--abbrev-ref", "HEAD"], root),
    // Uncommitted changes mean the commit alone does not name the code that ran.
    dirty: status === null ? null : status !== "",
    library: { name: pkg.name, version: pkg.version },
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
  };
}

/** The UTC calendar date, as result files are named. */
export function isoDate(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

/** `<dir>/<date>-<name>.json`, or `-2`, `-3`, … when a run from that day is already there. */
export function resultPath(dir, date, name) {
  for (let n = 1; ; n += 1) {
    const path = join(dir, `${date}-${name}${n === 1 ? "" : `-${n}`}.json`);
    if (!existsSync(path)) return path;
  }
}

export function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** Round for a published table: four places, as the LongMemEval scripts print. */
export function round4(x) {
  return Number.isFinite(x) ? Math.round(x * 10_000) / 10_000 : null;
}
