// The pure half of the release command (scripts/release.mjs): version math, the
// CHANGELOG and README rewrites, and the preflight checks. Everything that
// touches git, npm or the disk is passed in, so every refusal has a test.

/** The version after `kind` ("patch" | "minor" | "major" | "X.Y.Z"), refused if it does not move forward. */
export function nextVersion(current, kind) {
  const cur = parseVersion(current);
  if (!cur) throw new Error(`The current version "${current}" is not X.Y.Z.`);
  let next;
  if (kind === "patch") next = [cur[0], cur[1], cur[2] + 1];
  else if (kind === "minor") next = [cur[0], cur[1] + 1, 0];
  else if (kind === "major") next = [cur[0] + 1, 0, 0];
  else {
    next = parseVersion(kind);
    if (!next) throw new Error(`"${kind}" is not patch, minor, major or a version like 1.2.3.`);
  }
  if (compare(next, cur) <= 0) throw new Error(`${next.join(".")} is not newer than ${current}.`);
  return next.join(".");
}

function parseVersion(v) {
  const m = String(v).trim().match(/^(\d+)\.(\d+)\.(\d+)$/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function compare(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

const escapeDots = (v) => v.replace(/\./g, "\\.");

/** The version named by the newest "## X.Y.Z — unreleased" heading, or null. */
export function unreleasedVersion(changelog) {
  const m = changelog.match(/^## (\d+\.\d+\.\d+) — unreleased\s*$/m);
  return m ? m[1] : null;
}

/** The CHANGELOG with "## <version> — unreleased" dated. Refuses when that section is missing. */
export function dateChangelog(changelog, version, date) {
  const heading = new RegExp(`^## ${escapeDots(version)} — unreleased[ \\t]*$`, "m");
  if (!heading.test(changelog)) {
    const found = unreleasedVersion(changelog);
    throw new Error(
      found
        ? `CHANGELOG.md has an unreleased section for ${found}, not ${version}. Release ${found} instead, or rename that heading.`
        : `CHANGELOG.md has no "## ${version} — unreleased" section. Write what changed there first — a release without notes is not one.`,
    );
  }
  return changelog.replace(heading, `## ${version} — ${date}`);
}

/** The first line of prose under a version's heading, for the release commit's subject. */
export function releaseSummary(changelog, version) {
  const at = changelog.search(new RegExp(`^## ${escapeDots(version)} — `, "m"));
  if (at < 0) return "";
  for (const line of changelog.slice(at).split("\n").slice(1)) {
    const t = line.trim();
    if (t.startsWith("## ")) return "";
    if (t && !t.startsWith("#") && !t.startsWith("-")) return t.replace(/[.:]$/, "");
  }
  return "";
}

/**
 * package.json and package-lock.json with the version replaced where it names
 * THIS package: the first `"version"` in package.json, the first two in the lock
 * (top level and packages[""]). A text edit, so nothing else is reformatted.
 */
export function setVersion(text, from, to, occurrences) {
  let left = occurrences;
  const out = text.replace(new RegExp(`"version": "${escapeDots(from)}"`, "g"), (m) => (left-- > 0 ? `"version": "${to}"` : m));
  if (left > 0) throw new Error(`Expected ${occurrences} "version": "${from}" line(s) to replace, found ${occurrences - left}.`);
  return out;
}

/** The version the README's install line pins, or null. */
export function pinnedVersion(readme) {
  const m = readme.match(/--package=al-buddy-memory@(\d+\.\d+\.\d+)/);
  return m ? m[1] : null;
}

/** The README with every `al-buddy-memory@X.Y.Z` and the "Drop the `@X.Y.Z`" note moved to `version`. */
export function movePin(readme, version) {
  return readme
    .replace(/al-buddy-memory@\d+\.\d+\.\d+/g, `al-buddy-memory@${version}`)
    .replace(/Drop the `@\d+\.\d+\.\d+`/g, `Drop the \`@${version}\``);
}

/**
 * Other projects are named in the README comparison table only (CONTRIBUTING.md,
 * "Write against shapes and specs, not other vendors"). The pattern is built
 * from parts so this file does not find itself.
 */
export const NAME_SCAN_PATTERN = ["let" + "ta", "me" + "m0", "mem" + "gpt", "z" + "ep\\b", "graph" + "iti", "\\bme" + "ta\\b", "mu" + "se\\b"].join("|");
export const NAME_SCAN_EXCLUDES = [":!README.md", ":!package-lock.json", ":!docs/demo/index.html", ":!docs/RESILIENCE-LEDGER.md"];

/** Lines naming another project outside the allowed files. `run` throws when git grep finds nothing. */
export function nameScan(run) {
  let out = "";
  try {
    out = run("git", ["grep", "-niE", NAME_SCAN_PATTERN, "--", ".", ...NAME_SCAN_EXCLUDES]);
  } catch {
    return [];
  }
  return out.split("\n").filter((l) => l.trim() !== "");
}

/**
 * Why a release may not start. `run(cmd, args)` returns stdout and throws on a
 * failed command. An empty list means go.
 */
export function preflight(run, target) {
  const refusals = [];
  const branch = run("git", ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
  if (branch !== "main") refusals.push(`You are on "${branch}"; releases are cut from main.`);
  if (run("git", ["status", "--porcelain"]).trim() !== "") refusals.push("The working tree has uncommitted changes; commit or stash them first.");
  try {
    run("git", ["fetch", "--quiet", "origin", "main"]);
    const behind = Number(run("git", ["rev-list", "--count", "HEAD..origin/main"]).trim());
    if (behind > 0) refusals.push(`main is ${behind} commit(s) behind origin/main; pull first.`);
  } catch {
    refusals.push("Could not reach origin to check main is up to date.");
  }
  if (run("git", ["tag", "-l", `v${target}`]).trim() !== "") refusals.push(`Tag v${target} already exists.`);
  const hits = nameScan(run);
  if (hits.length > 0) {
    refusals.push(`The name scan found ${hits.length} line(s) naming another project outside the README table:\n${hits.map((h) => `    ${h}`).join("\n")}`);
  }
  return refusals;
}
