#!/usr/bin/env node
// The public repo guard (docs: CONTRIBUTING.md "The public repo guard").
//
//   npm run guard                      scan every commit not yet on a remote
//   npm run guard -- --range A..B      scan the commits git rev-list A..B selects
//   npm run guard:install              install it as .git/hooks/pre-push
//   (as the hook: --pre-push <remote> <url>, the ref updates on stdin)
//
// Refuses with the exact hit — commit, file:line or message line, rule, match —
// on a private name from the deny list outside the repo
// (~/.al-buddy-memory/private-names.txt, or $AL_BUDDY_MEMORY_PRIVATE_NAMES) or a
// built-in credential shape / do-not-publish marker. No deny list = built-ins only.
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { denyListPath, formatHits, loadDenyList, parsePrePushInput, scanCommits } from "./public-guard-lib.mjs";

const args = process.argv.slice(2);
const run = (cmd, argv) => execFileSync(cmd, argv, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024 });
const refuse = (text) => {
  console.error(`\nPublic repo guard: ${text}`);
  process.exit(1);
};

const HOOK = `#!/bin/sh
# Installed by: npm run guard:install (scripts/public-guard.mjs). Refuses a push
# that carries a private name or a credential into this public repo.
exec node "$(git rev-parse --show-toplevel)/scripts/public-guard.mjs" --pre-push "$@"
`;

if (args.includes("--install")) {
  const hooksDir = run("git", ["rev-parse", "--git-path", "hooks"]).trim();
  const target = join(hooksDir, "pre-push");
  if (existsSync(target) && readFileSync(target, "utf8") !== HOOK)
    refuse(`${target} already exists and is not this guard's. Add this line to it instead:\n    node "$(git rev-parse --show-toplevel)/scripts/public-guard.mjs" --pre-push "$@" || exit 1`);
  writeFileSync(target, HOOK);
  chmodSync(target, 0o755);
  console.log(`Installed ${target}. Every git push now runs the public repo guard.`);
  process.exit(0);
}

const listPath = denyListPath();
let names;
try {
  names = loadDenyList((p) => readFileSync(p, "utf8"), listPath);
} catch (err) {
  // Fail closed: a deny list that exists but cannot be read is not "no names".
  refuse(`could not read the deny list at ${listPath} (${err.message}).`);
}

let revSets;
if (args.includes("--pre-push")) {
  let input = "";
  try {
    input = readFileSync(0, "utf8");
  } catch {
    input = "";
  }
  revSets = parsePrePushInput(input).map((u) => ({ label: `${u.localRef} → ${u.remoteRef}`, revArgs: u.revArgs, fallback: [u.localSha, "--not", "--remotes"] }));
} else {
  const at = args.indexOf("--range");
  const range = at >= 0 ? args[at + 1] : undefined;
  if (at >= 0 && !range) refuse("--range needs a value, e.g. --range origin/main..HEAD");
  revSets = [{ label: range ?? "unpushed commits", revArgs: range ? [range] : ["HEAD", "--not", "--remotes"] }];
}

const hits = [];
for (const set of revSets) {
  try {
    hits.push(...scanCommits(run, set.revArgs, names));
  } catch (err) {
    // The remote's old tip may be unknown here (someone else's force push): scan everything not on a remote.
    if (!set.fallback) refuse(`could not list the commits for ${set.label} (${err.message.split("\n")[0]}).`);
    try {
      hits.push(...scanCommits(run, set.fallback, names));
    } catch (err2) {
      refuse(`could not list the commits for ${set.label} (${err2.message.split("\n")[0]}).`);
    }
  }
}

const source = names.length > 0 ? `${names.length} name(s) from ${listPath} + built-in patterns` : `built-in patterns only; no deny list at ${listPath}`;
if (hits.length > 0) {
  refuse(
    `push refused — ${hits.length} hit(s) in a PUBLIC repo (${source}):\n${formatHits(hits)}\n\n` +
      "Rewrite the commit (git commit --amend / git rebase) so the text is gone from history, then push again.\n" +
      "A built-in false positive (a fixture, a doc showing a key's shape) can carry the allow marker on that line; a private name cannot.",
  );
}
console.log(`Public repo guard: clean (${source}).`);
