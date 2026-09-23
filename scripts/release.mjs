#!/usr/bin/env node
// One release command (docs: CONTRIBUTING.md "Releasing").
//
//   npm run release -- <patch|minor|major|X.Y.Z> [--dry-run]
//     preflight → date the CHANGELOG → bump package.json + lock → gates →
//     commit → annotated tag → push main, then the tag. The tag's workflow STAGES
//     the npm publish; the maintainer approves it with 2FA.
//
//   npm run release:pin [--dry-run]
//     after that approval: once npm serves the new version, move the README's
//     install line to it, test, commit and push. Never before — a pin to a
//     version npm does not have yet is an install line that fails.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { dateChangelog, movePin, nextVersion, pinnedVersion, preflight, releaseSummary, setVersion, unreleasedVersion } from "./release-lib.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const positional = args.filter((a) => !a.startsWith("--"));
const pinMode = args.includes("--pin");

const run = (cmd, argv, opts = {}) => execFileSync(cmd, argv, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });
const step = (text) => console.log(`${dryRun ? "[dry run] " : ""}→ ${text}`);
const fail = (text) => {
  console.error(`\nRelease refused: ${text}`);
  process.exit(1);
};
const read = (p) => readFileSync(join(root, p), "utf8");
const write = (p, text) => {
  if (!dryRun) writeFileSync(join(root, p), text);
};
const gate = (label, cmd, argv) => {
  step(`${label}: ${cmd} ${argv.join(" ")}`);
  if (dryRun) return;
  try {
    execFileSync(cmd, argv, { cwd: root, stdio: "inherit" });
  } catch {
    fail(`${label} failed. Nothing was committed or tagged; the edited files are left for you to inspect (git diff).`);
  }
};

const current = JSON.parse(read("package.json")).version;

if (pinMode) {
  const pinned = pinnedVersion(read("README.md"));
  if (pinned === current) {
    console.log(`The README already pins ${current}. Nothing to do.`);
    process.exit(0);
  }
  let published = "";
  try {
    published = run("npm", ["view", "al-buddy-memory", "version"]).trim();
  } catch {
    fail("Could not ask npm which version is published.");
  }
  if (published !== current)
    fail(`npm serves ${published || "nothing"}, not ${current}. Approve the staged ${current} on npmjs.com (Staged Packages) first; the pin moves after.`);
  const branch = run("git", ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
  if (branch !== "main") fail(`You are on "${branch}"; the pin is moved on main.`);
  if (run("git", ["status", "--porcelain"]).trim() !== "") fail("The working tree has uncommitted changes.");
  step(`README install line: ${pinned} → ${current}`);
  write("README.md", movePin(read("README.md"), current));
  gate("tests", "npx", ["vitest", "run"]);
  step(`commit "The README's install line names ${current}"`);
  if (!dryRun) run("git", ["commit", "-qam", `The README's install line names ${current}`]);
  step("push main");
  if (!dryRun) run("git", ["push", "-q", "origin", "main"]);
  console.log(`\nDone: the README's install line names ${current}.`);
  process.exit(0);
}

const kind = positional[0];
if (!kind) fail("Say which release: npm run release -- <patch|minor|major|X.Y.Z> [--dry-run].");
let target;
try {
  target = nextVersion(current, kind);
} catch (err) {
  fail(err.message);
}
const changelog = read("CHANGELOG.md");
const pending = unreleasedVersion(changelog);
if (pending && pending !== target && !dryRun)
  fail(`CHANGELOG.md's unreleased section is ${pending}, not ${target}. Run: npm run release -- ${pending}`);

console.log(`Releasing al-buddy-memory ${current} → ${target}${dryRun ? " (dry run: nothing is changed)" : ""}\n`);
step("preflight: on main, clean tree, up to date with origin, tag free, name scan");
const refusals = preflight(run, target);
if (refusals.length > 0) {
  if (!dryRun) fail(refusals.join("\n"));
  for (const r of refusals) console.log(`[dry run] would refuse: ${r}`);
}

const today = new Date().toISOString().slice(0, 10);
let dated = changelog;
try {
  dated = dateChangelog(changelog, target, today);
} catch (err) {
  if (!dryRun) fail(err.message);
  console.log(`[dry run] would refuse: ${err.message}`);
}
step(`CHANGELOG.md: "## ${target} — unreleased" → "## ${target} — ${today}"`);
write("CHANGELOG.md", dated);
step(`package.json + package-lock.json: ${current} → ${target}`);
write("package.json", setVersion(read("package.json"), current, target, 1));
write("package-lock.json", setVersion(read("package-lock.json"), current, target, 2));

gate("typecheck", "npx", ["tsc", "--noEmit"]);
gate("tests", "npx", ["vitest", "run"]);
gate("build", "npm", ["run", "build"]);

const summary = releaseSummary(dated, target);
const subject = summary ? `${target} — ${summary}` : target;
step(`commit "${subject}"`);
if (!dryRun) run("git", ["commit", "-qam", subject]);
step(`annotated tag v${target}`);
if (!dryRun) run("git", ["tag", "-a", `v${target}`, "-m", target]);
step("push main, then the tag (the tag starts the release workflow)");
if (!dryRun) {
  run("git", ["push", "-q", "origin", "main"]);
  run("git", ["push", "-q", "origin", `v${target}`]);
}

console.log(`
${dryRun ? "Dry run complete — nothing was changed." : `Tagged v${target} and pushed.`}
Next, by hand:
  1. Wait for the "release" workflow (gh run list) — it stages ${target} on npm with provenance.
  2. Approve it: npmjs.com → al-buddy-memory → Staged Packages → Approve (2FA), or \`npm stage approve\`.
  3. Then: npm run release:pin   (moves the README install line to ${target} once npm serves it)`);
