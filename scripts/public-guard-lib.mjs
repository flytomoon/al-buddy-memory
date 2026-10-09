// The public repo guard's pure half (scripts/public-guard.mjs runs it as a
// pre-push hook; scripts/release.mjs runs it in preflight). It reads commit
// messages and the lines each commit adds, and refuses on:
//
//   1. private names from a deny list kept OUTSIDE the repo — by default
//      ~/.al-buddy-memory/private-names.txt, one name per line, `#` comments.
//      No file means no names: only the built-in patterns below run.
//   2. built-in generic patterns: credential shapes and a do-not-publish marker.
//
// This repo is public. The deny list's contents never belong in it; nothing in
// this file names a person, an employer or a domain. Every pattern is built so
// that this file's own text does not match it. Everything that touches git or
// the disk is passed in, so every refusal has a test.

import { homedir } from "node:os";
import { join } from "node:path";

/** Where the deny list lives unless AL_BUDDY_MEMORY_PRIVATE_NAMES points elsewhere. */
export function denyListPath(env = process.env, home = homedir()) {
  const override = env["AL_BUDDY_MEMORY_PRIVATE_NAMES"];
  return override && override.trim() !== "" ? override : join(home, ".al-buddy-memory", "private-names.txt");
}

/** The names in a deny list's text: trimmed, blank lines and `#` comments dropped, duplicates removed. */
export function parseDenyList(text) {
  const seen = new Set();
  const names = [];
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const name = raw.trim();
    if (name === "" || name.startsWith("#")) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  return names;
}

/** The deny list read with `readFile(path)`; a missing file is an empty list, any other read error throws. */
export function loadDenyList(readFile, path) {
  try {
    return parseDenyList(readFile(path));
  } catch (err) {
    if (err && err.code === "ENOENT") return [];
    throw err;
  }
}

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A case-insensitive matcher for one private name. Word edges are enforced
 * where the name starts or ends with a letter or digit, so a short name does
 * not fire inside a longer word; inner whitespace matches any run of it.
 */
export function nameMatcher(name) {
  const body = name.trim().split(/\s+/).map(escapeRegExp).join("\\s+");
  const start = /^[\p{L}\p{N}]/u.test(name.trim()) ? "(?<![\\p{L}\\p{N}_])" : "";
  const end = /[\p{L}\p{N}]$/u.test(name.trim()) ? "(?![\\p{L}\\p{N}_])" : "";
  return new RegExp(`${start}${body}${end}`, "giu");
}

/**
 * Generic shapes only: credentials with a recognisable prefix, private key
 * blocks, and the do-not-publish marker. `secret: true` hits are masked in the
 * report so the refusal does not copy a live credential into a log.
 */
export const BUILTIN_RULES = [
  { id: "private-key-block", secret: true, pattern: new RegExp("-----BEGIN (?:[A-Z0-9]+ )*PRIVATE" + " KEY-----", "g") },
  { id: "aws-access-key-id", secret: true, pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { id: "github-token", secret: true, pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/g },
  { id: "anthropic-key", secret: true, pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { id: "openai-key", secret: true, pattern: /\bsk-(?!ant-)(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}/g },
  { id: "slack-token", secret: true, pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  { id: "google-api-key", secret: true, pattern: /\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/g },
  { id: "stripe-live-key", secret: true, pattern: /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}/g },
  { id: "npm-token", secret: true, pattern: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { id: "telegram-bot-token", secret: true, pattern: /\b\d{8,10}:AA[A-Za-z0-9_-]{33}(?![A-Za-z0-9_-])/g },
  { id: "private-marker", secret: false, pattern: new RegExp("\\bTODO" + "[-_]PRIVATE\\b", "gi") },
];

/**
 * A line carrying this marker is skipped by the BUILT-IN rules (a test fixture,
 * a doc describing a key's shape). It never exempts a deny-list name: a private
 * name has no business in a public repo under any marker.
 */
export const ALLOW_MARKER = "public-guard" + ":allow";

function mask(text) {
  return text.length <= 8 ? `${text.slice(0, 2)}… (${text.length} chars)` : `${text.slice(0, 6)}… (${text.length} chars)`;
}

/** Every hit on one line of text: `{ rule, match }`, the match masked for secrets. */
export function scanLine(line, names) {
  const hits = [];
  for (const name of names) {
    for (const m of line.matchAll(nameMatcher(name))) hits.push({ rule: "private-name", match: m[0] });
  }
  if (!line.includes(ALLOW_MARKER)) {
    for (const rule of BUILTIN_RULES) {
      rule.pattern.lastIndex = 0;
      for (const m of line.matchAll(rule.pattern)) hits.push({ rule: rule.id, match: rule.secret ? mask(m[0]) : m[0] });
    }
  }
  return hits;
}

/**
 * The lines a `git show --unified=0` patch adds, with their file and new line
 * number, plus each changed path itself (a name can hide in a file name).
 */
export function addedLines(patch) {
  const out = [];
  let file = null;
  let lineNo = 0;
  for (const line of String(patch).split("\n")) {
    if (line.startsWith("+++ ")) {
      const path = line.slice(4).trim();
      file = path === "/dev/null" ? null : path.replace(/^b\//, "");
      if (file) out.push({ file, line: 0, text: file });
      continue;
    }
    if (line.startsWith("--- ") || line.startsWith("diff --git") || line.startsWith("index ")) continue;
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      lineNo = Number(hunk[1]);
      continue;
    }
    if (line.startsWith("+") && file) {
      out.push({ file, line: lineNo, text: line.slice(1) });
      lineNo++;
    } else if (line.startsWith("rename to ")) {
      out.push({ file: line.slice(10), line: 0, text: line.slice(10) });
    }
  }
  return out;
}

/** The hits in one commit, given its full message and its `--unified=0` patch. */
export function scanCommit(sha, message, patch, names) {
  const short = sha.slice(0, 7);
  const hits = [];
  String(message)
    .split("\n")
    .forEach((text, i) => {
      for (const h of scanLine(text, names)) hits.push({ ...h, where: `commit ${short} message line ${i + 1}` });
    });
  for (const { file, line, text } of addedLines(patch)) {
    for (const h of scanLine(text, names)) hits.push({ ...h, where: line === 0 ? `commit ${short} path ${file}` : `commit ${short} ${file}:${line}` });
  }
  return hits;
}

/**
 * Hits across the commits `revArgs` selects (anything `git rev-list` takes,
 * e.g. ["origin/main..HEAD"] or [sha, "--not", "--remotes"]). `run(cmd, args)`
 * returns stdout and throws on a failed command.
 */
export function scanCommits(run, revArgs, names) {
  const shas = run("git", ["rev-list", ...revArgs])
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  const hits = [];
  for (const sha of shas) {
    const message = run("git", ["log", "-1", "--format=%B", sha]);
    const patch = run("git", ["show", "--format=", "--unified=0", "--no-color", "--no-ext-diff", "-m", "--first-parent", sha]);
    hits.push(...scanCommit(sha, message, patch, names));
  }
  return hits;
}

/** Deny-list names anywhere in the tracked tree (the release checks what it ships, not just what is new). */
export function scanTreeForNames(run, names) {
  if (names.length === 0) return [];
  // Fixed strings keep this portable (not every git has PCRE); word edges are
  // then checked here with the same matcher the commit scan uses.
  const args = ["grep", "-n", "-i", "-I", "-F"];
  for (const name of names) args.push("-e", name);
  let out = "";
  try {
    out = run("git", args);
  } catch {
    return []; // git grep exits 1 when nothing matches
  }
  const hits = [];
  for (const l of out.split("\n")) {
    const m = l.match(/^(.+?):(\d+):(.*)$/);
    if (!m) continue;
    for (const name of names) {
      for (const found of m[3].matchAll(nameMatcher(name))) hits.push({ rule: "private-name", match: found[0], where: `tree ${m[1]}:${m[2]}` });
    }
  }
  return hits;
}

/** The refusal text for a list of hits, one line each, exact location first. */
export function formatHits(hits) {
  return hits.map((h) => `    ${h.where}: ${h.rule} "${h.match}"`).join("\n");
}

/** Git's pre-push stdin: `<local ref> <local sha> <remote ref> <remote sha>` per line. Deletions are skipped. */
export function parsePrePushInput(text) {
  const ZERO = /^0+$/;
  const updates = [];
  for (const line of String(text).split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length !== 4) continue;
    const [localRef, localSha, remoteRef, remoteSha] = parts;
    if (ZERO.test(localSha)) continue; // a branch deletion pushes no content
    updates.push({ localRef, localSha, remoteRef, revArgs: ZERO.test(remoteSha) ? [localSha, "--not", "--remotes"] : [`${remoteSha}..${localSha}`] });
  }
  return updates;
}
