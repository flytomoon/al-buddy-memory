import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const keyShape = [
  "sk-[A-Za-z0-9_-]{20,}", // OpenAI and Anthropic
  "(AKIA|ASIA)[A-Z0-9]{16}", // AWS long-term and temporary access key IDs
  "gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{82}", // GitHub tokens
].join("|");
const keyInPath = new RegExp(keyShape, "g");

function gitPaths(args: string[], allowNoMatch = false, input?: string): string[] {
  // Git returns paths only. Treat stderr as a failure without printing it.
  const { status, stdout, stderr } = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    input,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, LC_ALL: "C" },
  });
  if (stderr || (status !== 0 && !(allowNoMatch && status === 1))) {
    throw new Error("Git could not complete the check.");
  }
  return stdout.split("\0").filter(Boolean);
}

it("ignores the documented local environment files", () => {
  const paths = [".env", ".env.local", "bench/.env.omnimemeval", "bench/.envrc"];
  const ignored = gitPaths(["check-ignore", "--no-index", "-z", "--stdin"], true, `${paths.join("\0")}\0`);
  if (ignored.length !== paths.length) {
    throw new Error(`Checked ${paths.length} local environment paths, ${ignored.length} ignored.`);
  }
});

it("keeps local environment files and API key shapes out of tracked files", () => {
  const grep = ["--no-color", "--no-textconv", "-a", "-l", "-z", "-E", "-e", keyShape, "--"];
  const checks = [
    { label: "Tracked .env* paths", find: () => gitPaths(["ls-files", "-z"]).filter((path) => /(^|\/)\.env/.test(path)) },
    { label: "API key shapes in staged files", find: () => gitPaths(["grep", "--cached", ...grep], true) },
    { label: "API key shapes in checked-out tracked files", find: () => gitPaths(["grep", ...grep], true) },
  ];
  const failures: string[] = [];
  for (const { label, find } of checks) {
    try {
      const paths = find();
      if (paths.length > 0) {
        const names = [...new Set(paths)].map((path) => JSON.stringify(path.replace(keyInPath, "[redacted]")));
        failures.push(`${label} (${names.length})\n${names.join("\n")}`);
      }
    } catch {
      failures.push(`${label}. Git could not complete the check.`);
    }
  }
  if (failures.length > 0) {
    throw new Error(`Attempted ${checks.length} checks, ${checks.length - failures.length} passed.\n${failures.join("\n")}`);
  }
});
