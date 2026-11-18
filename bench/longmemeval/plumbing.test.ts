import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { REPO_ROOT, findResult, isoDate, mainCheckout, privateHistoryDirs, resolveResultsDir, resultPath, runInfo } from "../lib/run-info.mjs";
import { CHANNEL_ENV, METERED_ENV, UsageLimitError, answererFromSpec, claudeCli, parseClaudeJson, shellCommand, subscriptionEnv, withoutChannelEnv } from "./answerers.mjs";
import { downloadFile, fileUrl, pinManifest, readManifest, verifyFile } from "./download.mjs";

let dir: string;
let stub: string;

/** Stands in for `claude -p`: reports what it was given, or fails the way the CLI does. */
const STUB = `
import { appendFileSync, readFileSync } from "node:fs";
const input = readFileSync(0, "utf8");
const mode = process.env.STUB_MODE ?? "ok";
let count = 1;
if (process.env.STUB_COUNT) { appendFileSync(process.env.STUB_COUNT, "x"); count = readFileSync(process.env.STUB_COUNT, "utf8").length; }
const result = (r) => process.stdout.write(JSON.stringify({ type: "result", subtype: "success", modelUsage: { "stub-model-1": {} }, usage: { input_tokens: 5 }, total_cost_usd: 0.002, ...r }));
if (mode === "fail-once" && count === 1) { process.stderr.write("boom"); process.exit(1); }
else if (mode === "limit") { result({ is_error: true, result: "Claude AI usage limit reached|1760000000" }); process.exit(1); }
else if (mode === "sleep") setTimeout(() => {}, 10_000);
else result({ is_error: false, result: JSON.stringify({ argv: process.argv.slice(2), input, cwd: process.cwd(), present: ${JSON.stringify(METERED_ENV)}.filter((k) => k in process.env), channel: Object.keys(process.env).filter((k) => k.startsWith("TELEGRAM_")), keep: process.env.KEEP_ME ?? null }) });
`;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "longmemeval-test-"));
  stub = join(dir, "stub-claude.mjs");
  writeFileSync(stub, STUB);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A minimal environment: the tests never copy the real one, so no real key is ever handed to anything. */
const env = (extra: Record<string, string> = {}) => ({ PATH: process.env["PATH"] ?? "", ...extra });

describe("the claude -p answerer — the subscription, never a metered key", () => {
  it("drops the variables that would bill per call, by name, and keeps everything else", () => {
    const out = subscriptionEnv({ ANTHROPIC_API_KEY: "not-a-real-key", ANTHROPIC_AUTH_TOKEN: "not-a-real-token", CLAUDE_CODE_USE_BEDROCK: "1", HOME: "/h" });
    expect(out).toEqual({ HOME: "/h" });
  });

  it("never hands a chat channel's variables to a child: TELEGRAM_STATE_DIR and any TELEGRAM_*", async () => {
    expect(subscriptionEnv({ TELEGRAM_STATE_DIR: "/channel", TELEGRAM_BOT_TOKEN: "not-a-real-token", HOME: "/h" })).toEqual({ HOME: "/h" });
    expect(withoutChannelEnv({ TELEGRAM_STATE_DIR: "/channel", ANTHROPIC_API_KEY: "kept-for-a-command", NOT_TELEGRAM_X: "1" })).toEqual({ ANTHROPIC_API_KEY: "kept-for-a-command", NOT_TELEGRAM_X: "1" });
    expect(CHANNEL_ENV).toContain("TELEGRAM_STATE_DIR");

    const answerer = claudeCli({ command: [process.execPath, stub], env: env({ TELEGRAM_STATE_DIR: "/channel", TELEGRAM_BOT_TOKEN: "x", KEEP_ME: "kept" }), cwd: dir });
    const seen = JSON.parse((await answerer.complete("hi")).text);
    expect(seen.channel).toEqual([]);
    expect(seen.argv).toContain("--strict-mcp-config");
    expect(seen.keep).toBe("kept");

    const command = shellCommand(`node -e "process.stdout.write(Object.keys(process.env).filter((k) => k.startsWith('TELEGRAM_')).join(',') || 'none')"`, { env: env({ TELEGRAM_STATE_DIR: "/channel" }), cwd: dir });
    expect((await command.complete("")).text).toBe("none");
  });

  it("runs print mode with JSON out, no tools, safe mode, no saved session; the prompt goes in on stdin", async () => {
    const answerer = claudeCli({
      model: "sonnet",
      command: [process.execPath, stub],
      env: env({ ANTHROPIC_API_KEY: "not-a-real-key", ANTHROPIC_AUTH_TOKEN: "not-a-real-token", CLAUDE_CODE_USE_VERTEX: "1", KEEP_ME: "kept" }),
      cwd: dir,
    });
    const answer = await answerer.complete("What city do I live in?");
    const seen = JSON.parse(answer.text);
    expect(seen.input).toBe("What city do I live in?");
    expect(seen.argv).toEqual(["-p", "--output-format", "json", "--tools", "", "--safe-mode", "--strict-mcp-config", "--no-session-persistence", "--system-prompt", "You are a helpful assistant.", "--model", "sonnet"]);
    expect(seen.present).toEqual([]);
    expect(seen.keep).toBe("kept");
    expect(answer).toMatchObject({ modelIds: ["stub-model-1"], usage: { input_tokens: 5 }, notionalCostUsd: 0.002 });
    expect(answerer.describe()).toMatchObject({ kind: "claude-cli", requestedModel: "sonnet", systemPrompt: "You are a helpful assistant." });
  });

  it("retries a failed call, but not a usage limit", async () => {
    const count = join(dir, "count-retry");
    const flaky = claudeCli({ command: [process.execPath, stub], env: env({ STUB_MODE: "fail-once", STUB_COUNT: count }), retries: 1, retryDelayMs: 1, cwd: dir });
    expect((await flaky.complete("hi")).modelIds).toEqual(["stub-model-1"]);
    expect(readFileSync(count, "utf8")).toBe("xx");

    const limitCount = join(dir, "count-limit");
    const limited = claudeCli({ command: [process.execPath, stub], env: env({ STUB_MODE: "limit", STUB_COUNT: limitCount }), retries: 3, retryDelayMs: 1, cwd: dir });
    await expect(limited.complete("hi")).rejects.toBeInstanceOf(UsageLimitError);
    expect(readFileSync(limitCount, "utf8")).toBe("x");
  });

  it("gives up on a call that never returns", async () => {
    const slow = claudeCli({ command: [process.execPath, stub], env: env({ STUB_MODE: "sleep" }), timeoutMs: 300, retries: 0, cwd: dir });
    await expect(slow.complete("hi")).rejects.toThrow(/timed out/);
  });

  it("reads the CLI's JSON result, its list form, and its failures", () => {
    const ok = { type: "result", subtype: "success", is_error: false, result: "Berlin", modelUsage: { "claude-x": {}, "claude-y": {} } };
    expect(parseClaudeJson(JSON.stringify(ok))).toMatchObject({ text: "Berlin", modelIds: ["claude-x", "claude-y"], usage: null, notionalCostUsd: null });
    expect(parseClaudeJson(JSON.stringify([{ type: "system" }, ok])).text).toBe("Berlin");
    expect(() => parseClaudeJson("Invalid API key")).toThrow(/did not print JSON/);
    expect(() => parseClaudeJson(JSON.stringify({ ...ok, is_error: true, result: "Invalid API key · Please run /login" }))).toThrow(/claude -p failed: Invalid API key/);
    expect(() => parseClaudeJson(JSON.stringify({ ...ok, is_error: true, result: "5-hour limit reached ∙ resets 3pm" }))).toThrow(UsageLimitError);
    expect(() => parseClaudeJson(JSON.stringify({ type: "system" }))).toThrow(/without a result/);
  });
});

describe("other answerers", () => {
  it("any shell command: prompt on stdin, answer on stdout", async () => {
    const echo = shellCommand("cat", { env: env() });
    expect(await echo.complete("  Berlin\n")).toEqual({ text: "Berlin", modelIds: ["cat"], usage: null, notionalCostUsd: null });
    await expect(shellCommand("exit 3", { env: env(), retries: 0 }).complete("x")).rejects.toThrow(/exited 3/);
  });

  it("chosen by name on the command line", () => {
    expect(answererFromSpec("none")).toBeNull();
    expect(answererFromSpec("claude", { model: "opus" }).describe()).toMatchObject({ kind: "claude-cli", requestedModel: "opus" });
    expect(answererFromSpec("command:ollama run some-model").describe()).toEqual({ kind: "command", command: "ollama run some-model" });
    expect(() => answererFromSpec("openai")).toThrow(/Unknown answerer/);
  });
});

const json = (x: unknown) => new Response(JSON.stringify(x), { headers: { "content-type": "application/json" } });
const routes = (table: Record<string, () => Response>) => async (url: string) => (table[url] ?? (() => new Response("not found", { status: 404 })))();
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

describe("the dataset download — pinned to a commit, verified by SHA-256", () => {
  it("the manifest names the official cleaned release, and the data is neither committed nor published", () => {
    const manifest = readManifest();
    expect(manifest.repo).toBe("xiaowu0162/longmemeval-cleaned");
    expect(Object.keys(manifest.files)).toEqual(["s", "oracle"]);
    expect(readFileSync(join(REPO_ROOT, ".gitignore"), "utf8")).toMatch(/^bench\/longmemeval\/data\/$/m);
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
    expect(pkg.files).toContain("!bench/longmemeval/data");
  });

  it("builds the URL from the pinned commit, never a branch, and refuses without one", () => {
    const manifest = { repo: "o/r", revision: null, files: { s: { path: "f.json", sha256: null, bytes: null } } };
    expect(() => fileUrl(manifest, "s")).toThrow(/--pin/);
    expect(fileUrl({ ...manifest, revision: "a".repeat(40) }, "s")).toBe(`https://huggingface.co/datasets/o/r/resolve/${"a".repeat(40)}/f.json`);
    expect(() => fileUrl(manifest, "m")).toThrow(/no file "m"/);
  });

  it("--pin records the commit main points at and the SHA-256 Hugging Face holds for each file", async () => {
    const manifest = { repo: "o/r", revision: null, pinnedAt: null, files: { s: { path: "s.json", sha256: null, bytes: null }, oracle: { path: "oracle.json", sha256: null, bytes: null } } };
    const sha = "a".repeat(40);
    const fetchImpl = routes({
      "https://huggingface.co/api/datasets/o/r/revision/main": () => json({ sha }),
      [`https://huggingface.co/api/datasets/o/r/tree/${sha}`]: () =>
        json([
          { type: "file", path: "s.json", size: 134, lfs: { oid: "b".repeat(64), size: 1000, pointerSize: 134 } },
          { type: "file", path: "oracle.json", size: 7, oid: "c".repeat(40) },
        ]),
    });
    const pinned = await pinManifest(manifest, fetchImpl, new Date("2026-09-29T00:00:00Z"));
    expect(pinned).toMatchObject({ revision: sha, pinnedAt: "2026-09-29T00:00:00.000Z" });
    expect(pinned.files).toEqual({ s: { path: "s.json", sha256: "b".repeat(64), bytes: 1000 }, oracle: { path: "oracle.json", sha256: null, bytes: 7 } });
    await expect(pinManifest({ ...manifest, files: { m: { path: "m.json", sha256: null, bytes: null } } }, fetchImpl)).rejects.toThrow(/m.json is not in o\/r/);
  });

  it("keeps a download only when it matches, and leaves nothing behind when it does not", async () => {
    const fetchImpl = routes({ "https://x/f": () => new Response("hello\n") });
    const dest = join(dir, "data", "f.json");
    await expect(downloadFile("https://x/f", dest, { sha256: "0".repeat(64), bytes: null }, fetchImpl)).rejects.toThrow(/nothing kept/);
    expect(existsSync(dest) || existsSync(`${dest}.part`)).toBe(false);
    await expect(downloadFile("https://x/f", dest, { sha256: null, bytes: 3 }, fetchImpl)).rejects.toThrow(/6 bytes, expected 3/);
    await expect(downloadFile("https://x/missing", dest, { sha256: null, bytes: null }, fetchImpl)).rejects.toThrow(/HTTP 404/);

    expect(await downloadFile("https://x/f", dest, { sha256: sha256("hello\n"), bytes: 6 }, fetchImpl)).toEqual({ sha256: sha256("hello\n"), bytes: 6 });
    expect(readFileSync(dest, "utf8")).toBe("hello\n");
    expect(await verifyFile(dest, { sha256: sha256("hello\n"), bytes: 6 })).toBeNull();
    expect(await verifyFile(dest, { sha256: sha256("hello\n"), bytes: 7 })).toBe("size 6, expected 7");
    expect(await verifyFile(dest, { sha256: "0".repeat(64), bytes: null })).toBe(`SHA-256 ${sha256("hello\n")}, expected ${"0".repeat(64)}`);
    expect(await verifyFile(dest, { sha256: null, bytes: null })).toMatch(/no SHA-256/);
  });
});

describe("what every result file carries", () => {
  it("the commit, whether the tree was clean, the runtime and the library version", () => {
    const info = runInfo();
    expect(info.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(typeof info.dirty).toBe("boolean");
    expect(info.library.name).toBe("al-buddy-memory");
    expect(info.node).toBe(process.version);
  });

  it("a dated name that never overwrites an earlier result", () => {
    expect(isoDate(new Date("2026-09-29T23:59:00Z"))).toBe("2026-09-29");
    const first = resultPath(dir, "2026-09-29", "longmemeval");
    expect(first).toBe(join(dir, "2026-09-29-longmemeval.json"));
    writeFileSync(first, "{}");
    expect(resultPath(dir, "2026-09-29", "longmemeval")).toBe(join(dir, "2026-09-29-longmemeval-2.json"));
    // A results folder that does not exist yet is made, so files copied beside the result have somewhere to go.
    const fresh = join(dir, "not-yet", "made");
    expect(resultPath(fresh, "2026-09-29", "x")).toBe(join(fresh, "2026-09-29-x.json"));
    expect(existsSync(fresh)).toBe(true);
  });
});

describe("where results go", () => {
  const root = "/work/al-buddy-memory";
  const privateDir = "/work/al-buddy-memory-enterprise/bench/results-history";
  const none = () => false;

  it("BENCH_RESULTS_DIR first (relative to the repo root), then the private history beside the checkout, else bench/results", () => {
    expect(resolveResultsDir({ env: { BENCH_RESULTS_DIR: "/runs" }, root, exists: () => true })).toBe("/runs");
    expect(resolveResultsDir({ env: { BENCH_RESULTS_DIR: "out/runs" }, root, exists: none })).toBe(join(root, "out/runs"));
    // Blank is unset, not "the repo root".
    expect(resolveResultsDir({ env: { BENCH_RESULTS_DIR: "  " }, root, exists: (p: string) => p === privateDir })).toBe(privateDir);
    expect(resolveResultsDir({ env: {}, root, exists: (p: string) => p === privateDir })).toBe(privateDir);
    expect(resolveResultsDir({ env: {}, root, exists: none })).toBe(join(root, "bench", "results"));
  });

  it("from a git worktree, finds the private history beside the main checkout", () => {
    const base = mkdtempSync(join(tmpdir(), "al-results-"));
    try {
      const main = join(base, "al-buddy-memory");
      const wt = join(main, ".claude", "worktrees", "job");
      const wtGit = join(main, ".git", "worktrees", "job");
      mkdirSync(wt, { recursive: true });
      mkdirSync(wtGit, { recursive: true });
      writeFileSync(join(wt, ".git"), `gitdir: ${wtGit}\n`);
      writeFileSync(join(wtGit, "commondir"), "../..\n");
      expect(mainCheckout(wt)).toBe(main);
      expect(mainCheckout(main)).toBe(main);
      const history = join(base, "al-buddy-memory-enterprise", "bench", "results-history");
      expect(privateHistoryDirs(wt)).toContain(history);
      expect(resolveResultsDir({ env: {}, root: wt })).toBe(join(wt, "bench", "results"));
      mkdirSync(history, { recursive: true });
      expect(resolveResultsDir({ env: {}, root: wt })).toBe(history);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("a published input is looked for in each folder in turn, and a miss says where it looked", () => {
    const found = findResult("a.json", { dirs: ["/x", "/y", "/x"], exists: (p: string) => p === "/y/a.json" });
    expect(found).toEqual({ path: "/y/a.json", searched: ["/x", "/y"] });
    expect(findResult("a.json", { dirs: ["/x"], exists: none })).toEqual({ path: null, searched: ["/x"] });
  });
});
