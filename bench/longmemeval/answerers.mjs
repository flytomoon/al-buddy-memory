/**
 * Who answers the question, and who judges the answer. Both are an
 * "answerer": `complete(prompt)` resolves to `{ text, modelIds, usage }`.
 *
 *   - `claudeCli` (the default): the Claude Code CLI in print mode, on the
 *     Claude subscription it is logged in with — no metered API spend. The
 *     child process gets the caller's environment MINUS the variables that
 *     would switch it to metered billing (an API key, an auth token, a cloud
 *     provider). They are removed by name; their values are never read.
 *   - `shellCommand`: any command that reads a prompt on stdin and prints the
 *     answer, e.g. a local model. The benchmark does not care who answers; the
 *     result file records it.
 */
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";

/** Removed from the CLI's environment so it can only use the subscription login. */
export const METERED_ENV = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
];

/** A neutral system prompt in place of the CLI's own coding-agent one; the official runs send none. */
export const DEFAULT_SYSTEM_PROMPT = "You are a helpful assistant.";

/** The subscription stopped answering (usage limit). Retrying burns nothing but time; the run stops and can resume. */
export class UsageLimitError extends Error {}

export function subscriptionEnv(env = process.env) {
  const out = { ...env };
  for (const name of METERED_ENV) delete out[name];
  return out;
}

/** Run `argv` with `input` on stdin; never rejects on a non-zero exit, only when the process cannot start. */
export function runProcess(argv, input, { env, cwd, timeoutMs, shell = false }) {
  return new Promise((resolve, reject) => {
    const child = shell ? spawn(argv[0], { env, cwd, shell: true }) : spawn(argv[0], argv.slice(1), { env, cwd });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    child.stdout.setEncoding("utf8").on("data", (d) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d) => (stderr += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, timedOut });
    });
    child.stdin.on("error", () => {}); // the child may exit before reading everything
    child.stdin.end(input);
  });
}

const LIMIT_TEXT = /usage limit|limit reached|rate limit/i;

/**
 * The `--output-format json` result of `claude -p`: one result object (or,
 * with --verbose, a list of messages ending in one). `modelUsage` is keyed by
 * the model ids that actually answered.
 */
export function parseClaudeJson(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`claude -p did not print JSON: ${JSON.stringify(stdout.slice(0, 300))}`);
  }
  const result = Array.isArray(parsed) ? parsed.findLast((m) => m?.type === "result") : parsed;
  if (!result || result.type !== "result") throw new Error("claude -p printed JSON without a result message");
  if (result.is_error || result.subtype !== "success" || typeof result.result !== "string") {
    const why = typeof result.result === "string" ? result.result : result.subtype ?? "unknown error";
    if (LIMIT_TEXT.test(why)) throw new UsageLimitError(`Claude subscription limit: ${why}`);
    throw new Error(`claude -p failed: ${why}`);
  }
  return {
    text: result.result,
    modelIds: Object.keys(result.modelUsage ?? {}),
    usage: result.usage ?? null,
    // What the same tokens would cost at API prices. On a subscription nothing is billed per call.
    notionalCostUsd: typeof result.total_cost_usd === "number" ? result.total_cost_usd : null,
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withRetries(fn, { retries, retryDelayMs }) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof UsageLimitError || attempt >= retries) throw e;
      await sleep(retryDelayMs * (attempt + 1));
    }
  }
}

/**
 * The Claude Code CLI as an answerer. `command` is the argv prefix that starts
 * it (default `claude`), so a test can put a stub in its place.
 */
export function claudeCli({
  model,
  command = ["claude"],
  system = DEFAULT_SYSTEM_PROMPT,
  effort,
  timeoutMs = 300_000,
  retries = 2,
  retryDelayMs = 10_000,
  env = process.env,
  cwd = tmpdir(),
} = {}) {
  // Print mode, JSON out, no tools, none of the user's CLAUDE.md, hooks, MCP servers or
  // plugins (--safe-mode), nothing saved as a session. The prompt goes in on stdin.
  const args = ["-p", "--output-format", "json", "--tools", "", "--safe-mode", "--strict-mcp-config", "--no-session-persistence", "--system-prompt", system];
  if (model) args.push("--model", model);
  if (effort) args.push("--effort", effort);
  const childEnv = subscriptionEnv(env);
  return {
    kind: "claude-cli",
    describe: () => ({
      kind: "claude-cli",
      requestedModel: model ?? "(CLI default)",
      command: [...command, ...args.map((a) => (a === system ? "<system prompt>" : a === "" ? '""' : a))].join(" "),
      systemPrompt: system,
      ...(effort ? { effort } : {}),
      billing: "Claude subscription; the child environment has no API key, auth token or cloud-provider switch",
    }),
    async complete(prompt) {
      return withRetries(
        async () => {
          const run = await runProcess([...command, ...args], prompt, { env: childEnv, cwd, timeoutMs });
          if (run.timedOut) throw new Error(`claude -p timed out after ${timeoutMs} ms`);
          if (run.stdout.trim() === "") throw new Error(`claude -p exited ${run.code} with no output: ${run.stderr.slice(-500).trim()}`);
          return parseClaudeJson(run.stdout);
        },
        { retries, retryDelayMs },
      );
    },
  };
}

/** Any shell command as an answerer: the prompt on stdin, the answer on stdout. */
export function shellCommand(cmd, { timeoutMs = 300_000, retries = 1, retryDelayMs = 5_000, env = process.env, cwd = tmpdir() } = {}) {
  return {
    kind: "command",
    describe: () => ({ kind: "command", command: cmd }),
    async complete(prompt) {
      return withRetries(
        async () => {
          const run = await runProcess([cmd], prompt, { env, cwd, timeoutMs, shell: true });
          if (run.timedOut) throw new Error(`"${cmd}" timed out after ${timeoutMs} ms`);
          if (run.code !== 0) throw new Error(`"${cmd}" exited ${run.code}: ${run.stderr.slice(-500).trim()}`);
          return { text: run.stdout.trim(), modelIds: [cmd], usage: null, notionalCostUsd: null };
        },
        { retries, retryDelayMs },
      );
    },
  };
}

/**
 * `claude` (the default), `command:<shell command>`, or `none`. `model` only
 * applies to `claude`.
 */
export function answererFromSpec(spec, { model, effort, claudeCommand } = {}) {
  if (spec === "none") return null;
  if (spec === "claude") return claudeCli({ model, effort, ...(claudeCommand ? { command: claudeCommand } : {}) });
  if (spec.startsWith("command:")) return shellCommand(spec.slice("command:".length));
  throw new Error(`Unknown answerer "${spec}" (use claude, command:<shell command>, or none)`);
}
