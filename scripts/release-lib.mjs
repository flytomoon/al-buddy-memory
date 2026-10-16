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
 * The Claude Code plugin's files that name the package version (plugin/): the
 * MCP server and hook launch `al-buddy-memory@X.Y.Z`, its README's examples do,
 * and plugin.json's `version` is what Claude Code compares to offer an update.
 * They move WITH the README pin, after npm serves the version — a plugin that
 * launches a version npm does not have is a plugin that does not start.
 */
export const PLUGIN_PIN_FILES = [
  "plugin/.mcp.json",
  "plugin/hooks/hooks.json",
  "plugin/README.md",
  "plugin/.claude-plugin/plugin.json",
  "plugin/commands/status.md",
  "plugin/commands/export.md",
  "plugin/commands/import.md",
];

/** One plugin file with its package pins (and, in plugin.json, its `version`) moved to `version`. */
export function movePluginPin(text, version) {
  return text
    .replace(/al-buddy-memory@\d+\.\d+\.\d+/g, `al-buddy-memory@${version}`)
    .replace(/("version"\s*:\s*")\d+\.\d+\.\d+(")/, `$1${version}$2`);
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

/**
 * The launchd label of the remote connector a maintainer's Mac may run
 * (al-buddy-memory-http from this checkout). Override it with
 * AL_BUDDY_MEMORY_CONNECTOR_LABEL; a Mac without the job is skipped quietly.
 */
export const CONNECTOR_LABEL = "com.al-buddy.memory-connector";

/** The lines of one `name = { … }` block of `launchctl print` output — the block named exactly `name` — or null. */
function launchdBlock(printed, name) {
  const m = String(printed).match(new RegExp(`^[ \\t]*${name} = \\{[ \\t]*\\n([\\s\\S]*?)^[ \\t]*\\}`, "m"));
  return m ? m[1].split("\n").map((l) => l.trim()).filter(Boolean) : null;
}

/** The job's own `environment = { KEY => value }` from `launchctl print` (not the inherited or default ones). */
export function launchdEnvironment(printed) {
  const env = {};
  for (const line of launchdBlock(printed, "environment") ?? []) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*) => (.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}

/** The job's program arguments from `launchctl print`. */
export function launchdArguments(printed) {
  return launchdBlock(printed, "arguments") ?? [];
}

/** The running job's pid from `launchctl print`, or null when it is not running. */
export function launchdPid(printed) {
  const m = String(printed).match(/^[ \t]*pid = (\d+)[ \t]*$/m);
  return m ? Number(m[1]) : null;
}

/** Whether a /health answer is the connector's `{ "ok": true }`, and if not, why. */
async function health(fetchFn, url, timeoutMs) {
  try {
    const res = await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { ok: false, why: `HTTP ${res.status}` };
    const body = await res.json().catch(() => null);
    return body && body.ok === true ? { ok: true } : { ok: false, why: "the answer was not { ok: true }" };
  } catch (err) {
    return { ok: false, why: err instanceof Error ? err.message : String(err) };
  }
}

/** The line of a failed command's output that says why: the first naming an error, else the first. */
function failureLine(err) {
  const out = err && typeof err === "object" ? `${err.stdout ?? ""}\n${err.stderr ?? ""}` : "";
  const lines = `${out}\n${err instanceof Error ? err.message : String(err)}`.split("\n").map((l) => l.trim()).filter(Boolean);
  return lines.find((l) => /error/i.test(l)) ?? lines[0] ?? "unknown error";
}

/**
 * After the pins move: when this Mac runs the remote connector under launchd,
 * rebuild dist/ (the job runs bin/al-buddy-memory-http.js, which loads it),
 * restart the job, and check /health on 127.0.0.1 and on its public URL.
 * The port and public URL come from the job's own environment first (what it
 * actually serves), then this shell's AL_BUDDY_MEMORY_PORT and
 * AL_BUDDY_MEMORY_PUBLIC_URL. Not macOS, or no such job: `skipped`, no lines.
 * `run(cmd, args)` returns stdout and throws on a failed command.
 */
export async function refreshConnector({ run, fetch: fetchFn, sleep, env, platform, uid, root, dryRun = false, attempts = 20, intervalMs = 1000, timeoutMs = 3000 }) {
  if (platform !== "darwin" || uid === undefined || uid === null) return { skipped: true, ok: true, lines: [] };
  const label = (env.AL_BUDDY_MEMORY_CONNECTOR_LABEL ?? "").trim() || CONNECTOR_LABEL;
  const target = `gui/${uid}/${label}`;
  let printed;
  try {
    printed = run("launchctl", ["print", target]);
  } catch {
    return { skipped: true, ok: true, lines: [] };
  }
  const service = launchdEnvironment(printed);
  const port = (service.AL_BUDDY_MEMORY_PORT ?? env.AL_BUDDY_MEMORY_PORT ?? "").trim() || "8787";
  const publicUrl = (service.AL_BUDDY_MEMORY_PUBLIC_URL ?? env.AL_BUDDY_MEMORY_PUBLIC_URL ?? "").trim();
  const localHealth = `http://127.0.0.1:${port}/health`;
  const publicHealth = publicUrl ? `${publicUrl.replace(/\/+$/, "")}/health` : "";
  const retry = `npm run build && launchctl kickstart -k ${target}`;
  const lines = [`Remote connector (${label}):`];

  const script = launchdArguments(printed).find((a) => a.endsWith("al-buddy-memory-http.js"));
  const ours = `${root.replace(/\/+$/, "")}/bin/al-buddy-memory-http.js`;
  if (script && script !== ours) lines.push(`  note: the job runs ${script}, not this checkout's bin/; the build here does not change what it serves`);

  if (dryRun) {
    lines.push(`  [dry run] would rebuild (npm run build), restart (launchctl kickstart -k ${target}), then check ${localHealth}${publicHealth ? ` and ${publicHealth}` : ""}`);
    return { skipped: false, ok: true, lines };
  }

  try {
    run("npm", ["run", "build"]);
    lines.push("  rebuilt: npm run build");
  } catch (err) {
    lines.push(`  build FAILED, so the job was not restarted (it keeps serving the code it loaded): ${failureLine(err)}`, `  retry: ${retry}`);
    return { skipped: false, ok: false, lines };
  }

  const before = launchdPid(printed);
  try {
    run("launchctl", ["kickstart", "-k", target]);
  } catch (err) {
    lines.push(`  restart FAILED: launchctl kickstart -k ${target}: ${failureLine(err)}`, `  retry: ${retry}`);
    return { skipped: false, ok: false, lines };
  }

  // kickstart -k signals the old process; until a new pid is up, a /health answer may still be the old one's.
  let pid = null;
  let local = { ok: false, why: "no new process came up" };
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await sleep(intervalMs);
    if (pid === null) {
      let now = null;
      try {
        now = launchdPid(run("launchctl", ["print", target]));
      } catch {
        // between the old process and the new one: ask again
      }
      if (now === null || now === before) continue;
      pid = now;
    }
    local = await health(fetchFn, localHealth, timeoutMs);
    if (local.ok) break;
  }
  lines.push(pid === null ? "  restarted: launchctl kickstart -k, but no new pid was seen" : `  restarted: pid ${before ?? "none"} → ${pid}`);
  lines.push(`  local  ${localHealth}: ${local.ok ? "ok" : `FAILED (${local.why})`}`);
  if (!local.ok) {
    lines.push(`  public not checked, as the local check failed. Retry: ${retry}`);
    return { skipped: false, ok: false, lines };
  }

  if (!publicHealth) {
    lines.push("  public not checked: no AL_BUDDY_MEMORY_PUBLIC_URL in the job's environment or this shell");
    return { skipped: false, ok: true, lines };
  }
  let remote = { ok: false, why: "not tried" };
  for (let i = 0; i < Math.max(1, Math.ceil(attempts / 4)); i++) {
    if (i > 0) await sleep(intervalMs);
    remote = await health(fetchFn, publicHealth, timeoutMs);
    if (remote.ok) break;
  }
  lines.push(`  public ${publicHealth}: ${remote.ok ? "ok" : `FAILED (${remote.why}); the connector is up locally, so check the tunnel`}`);
  return { skipped: false, ok: remote.ok, lines };
}
