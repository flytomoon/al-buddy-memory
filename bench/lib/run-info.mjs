/**
 * What every published benchmark result carries besides its numbers: the code
 * it ran (commit, and whether the tree was clean), the runtime, and a file name
 * that never overwrites an earlier result.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The repository root: two levels above this file. */
export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
/** The headline results committed here; new runs go here only without the private history. */
export const PUBLIC_RESULTS_DIR = join(REPO_ROOT, "bench", "results");
/** A run in flight (for --resume). Always in this checkout, and ignored by git. */
export const PROGRESS_DIR = join(PUBLIC_RESULTS_DIR, ".progress");

/**
 * The main checkout of a git worktree (the folder holding the shared .git), or
 * the root itself. Read from the files git writes, so no git process is needed.
 */
export function mainCheckout(root = REPO_ROOT) {
  try {
    const dotGit = readFileSync(join(root, ".git"), "utf8");
    const gitdir = dotGit.match(/^gitdir:\s*(.+)$/m)?.[1]?.trim();
    if (!gitdir) return root;
    const worktreeGitDir = resolve(root, gitdir);
    const common = readFileSync(join(worktreeGitDir, "commondir"), "utf8").trim();
    return dirname(resolve(worktreeGitDir, common));
  } catch {
    // .git is a directory (a plain checkout), or missing: the root is the checkout.
    return root;
  }
}

/** Where the private repo keeps the run history: beside this checkout, or beside its main checkout. */
export function privateHistoryDirs(root = REPO_ROOT) {
  const dirs = [root, mainCheckout(root)].map((r) => resolve(r, "..", "al-buddy-memory-enterprise", "bench", "results-history"));
  return [...new Set(dirs)];
}

/**
 * Where a run writes its result: $BENCH_RESULTS_DIR when set (a relative path
 * is read from the repository root), else the private repo's results-history
 * when that folder exists, else bench/results here, so a contributor without
 * the private repo still gets their results.
 */
export function resolveResultsDir({ env = process.env, root = REPO_ROOT, exists = existsSync } = {}) {
  const set = env.BENCH_RESULTS_DIR?.trim();
  if (set) return isAbsolute(set) ? set : resolve(root, set);
  return privateHistoryDirs(root).find((dir) => exists(dir)) ?? join(root, "bench", "results");
}

export const RESULTS_DIR = resolveResultsDir();

/**
 * A committed result a script reads (the published run, its labels): the
 * results folder first, then bench/results here, then the private history.
 * Null when it is in none of them; `searched` says where it looked.
 */
export function findResult(name, { dirs = [RESULTS_DIR, PUBLIC_RESULTS_DIR, ...privateHistoryDirs()], exists = existsSync } = {}) {
  const searched = [...new Set(dirs)];
  const path = searched.map((dir) => join(dir, name)).find((p) => exists(p)) ?? null;
  return { path, searched };
}

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

/**
 * `<dir>/<date>-<name>.json`, or `-2`, `-3`, … when a run from that day is
 * already there. Creates `dir`, so files written or copied beside the result
 * (hypotheses, summaries) have a folder to go in.
 */
export function resultPath(dir, date, name) {
  mkdirSync(dir, { recursive: true });
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
