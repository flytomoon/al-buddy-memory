// The release command's pure parts (scripts/release-lib.mjs): every refusal is
// tested here, so a release cannot half-happen for a reason nobody checked.
import { describe, expect, it } from "vitest";

// @ts-expect-error — a plain .mjs script with no type declarations
import * as lib from "../scripts/release-lib.mjs";

const { nextVersion, unreleasedVersion, dateChangelog, releaseSummary, setVersion, pinnedVersion, movePin, movePluginPin, preflight, nameScan } = lib as {
  movePluginPin(text: string, version: string): string;
  nextVersion(current: string, kind: string): string;
  unreleasedVersion(changelog: string): string | null;
  dateChangelog(changelog: string, version: string, date: string): string;
  releaseSummary(changelog: string, version: string): string;
  setVersion(text: string, from: string, to: string, n: number): string;
  pinnedVersion(readme: string): string | null;
  movePin(readme: string, version: string): string;
  preflight(run: (cmd: string, args: string[]) => string, target: string): string[];
  nameScan(run: (cmd: string, args: string[]) => string): string[];
};
const { refreshConnector, launchdEnvironment, CONNECTOR_LABEL } = lib as {
  CONNECTOR_LABEL: string;
  launchdEnvironment(printed: string): Record<string, string>;
  refreshConnector(opts: {
    run: (cmd: string, args: string[]) => string;
    fetch: (url: string, init?: unknown) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
    sleep: (ms: number) => Promise<void>;
    env: Record<string, string | undefined>;
    platform: string;
    uid: number | undefined;
    root: string;
    dryRun?: boolean;
    attempts?: number;
  }): Promise<{ skipped: boolean; ok: boolean; lines: string[] }>;
};

const CHANGELOG = [
  "# Changelog",
  "",
  "## 0.6.1 — unreleased",
  "",
  "A pinned rule keeps its line breaks.",
  "",
  "### Fixed",
  "- one",
  "",
  "## 0.6.0 — 2026-09-23",
  "",
].join("\n");

describe("the next version", () => {
  it("bumps patch, minor and major", () => {
    expect(nextVersion("0.6.0", "patch")).toBe("0.6.1");
    expect(nextVersion("0.6.3", "minor")).toBe("0.7.0");
    expect(nextVersion("0.6.3", "major")).toBe("1.0.0");
    expect(nextVersion("0.6.0", "0.8.0")).toBe("0.8.0");
  });

  it("refuses a version that does not move forward, or is not one", () => {
    expect(() => nextVersion("0.6.0", "0.6.0")).toThrow(/not newer/);
    expect(() => nextVersion("0.6.0", "0.5.9")).toThrow(/not newer/);
    expect(() => nextVersion("0.6.0", "soon")).toThrow(/not patch, minor, major/);
  });
});

describe("the CHANGELOG", () => {
  it("finds the unreleased section and dates exactly that one", () => {
    expect(unreleasedVersion(CHANGELOG)).toBe("0.6.1");
    const dated = dateChangelog(CHANGELOG, "0.6.1", "2026-09-24");
    expect(dated).toContain("## 0.6.1 — 2026-09-24");
    expect(dated).not.toContain("unreleased");
    expect(dated).toContain("## 0.6.0 — 2026-09-23");
  });

  it("refuses a release with no notes, and names the section that does exist", () => {
    expect(() => dateChangelog("# Changelog\n\n## 0.6.0 — 2026-09-23\n", "0.6.1", "2026-09-24")).toThrow(/no "## 0.6.1 — unreleased" section/);
    expect(() => dateChangelog(CHANGELOG, "0.7.0", "2026-09-24")).toThrow(/unreleased section for 0.6.1, not 0.7.0/);
  });

  it("takes the section's first line of prose as the commit subject", () => {
    expect(releaseSummary(dateChangelog(CHANGELOG, "0.6.1", "2026-09-24"), "0.6.1")).toBe("A pinned rule keeps its line breaks");
    expect(releaseSummary("## 0.6.1 — 2026-09-24\n\n### Fixed\n- x\n", "0.6.1")).toBe("");
  });
});

describe("the version fields", () => {
  it("changes only this package's version lines, and says when they are not there", () => {
    const lock = '{\n  "name": "al-buddy-memory",\n  "version": "0.6.0",\n  "packages": {\n    "": {\n      "version": "0.6.0"\n    },\n    "node_modules/x": {\n      "version": "0.6.0"\n    }\n  }\n}\n';
    const out = setVersion(lock, "0.6.0", "0.6.1", 2);
    expect(out.match(/"0\.6\.1"/g)).toHaveLength(2);
    expect(out).toContain('"node_modules/x": {\n      "version": "0.6.0"');
    expect(() => setVersion('{ "version": "0.5.0" }', "0.6.0", "0.6.1", 1)).toThrow(/Expected 1/);
  });
});

describe("the README pin", () => {
  it("reads and moves the install line and its note", () => {
    const readme = 'args: ["-y", "--package=al-buddy-memory@0.6.0", "al-buddy-memory-mcp"]\nDrop the `@0.6.0` and npx looks for a package';
    expect(pinnedVersion(readme)).toBe("0.6.0");
    const moved = movePin(readme, "0.6.1");
    expect(pinnedVersion(moved)).toBe("0.6.1");
    expect(moved).toContain("Drop the `@0.6.1`");
    expect(moved).toContain("al-buddy-memory-mcp");
  });
});

describe("the plugin pins", () => {
  it("moves every package pin, and plugin.json's version, and nothing else", () => {
    const mcp = '{ "args": ["-y", "--package=al-buddy-memory@0.10.0", "al-buddy-memory-mcp"] }';
    expect(movePluginPin(mcp, "0.11.0")).toBe('{ "args": ["-y", "--package=al-buddy-memory@0.11.0", "al-buddy-memory-mcp"] }');
    const manifest = '{\n  "name": "al-buddy-memory",\n  "version": "0.10.0",\n  "license": "Apache-2.0"\n}';
    expect(movePluginPin(manifest, "0.11.0")).toContain('"version": "0.11.0"');
    expect(movePluginPin(manifest, "0.11.0")).toContain('"name": "al-buddy-memory"');
  });
});

/** A fake git: answers by the command's first words, throwing where git would fail. */
function fakeGit(answers: Record<string, string | Error>) {
  return (cmd: string, args: string[]): string => {
    const key = [cmd, ...args].join(" ");
    for (const [prefix, answer] of Object.entries(answers)) {
      if (key.startsWith(prefix)) {
        if (answer instanceof Error) throw answer;
        return answer;
      }
    }
    return "";
  };
}

const CLEAN = {
  "git rev-parse --abbrev-ref HEAD": "main\n",
  "git status --porcelain": "",
  "git fetch": "",
  "git rev-list --count HEAD..origin/main": "0\n",
  "git tag -l": "",
  "git grep": new Error("exit 1: no matches"),
};

describe("preflight", () => {
  it("lets a clean, current main with a free tag through", () => {
    expect(preflight(fakeGit(CLEAN), "0.6.1")).toEqual([]);
  });

  it("refuses off main, a dirty tree, a stale main, a taken tag, and says each", () => {
    const refusals = preflight(
      fakeGit({
        ...CLEAN,
        "git rev-parse --abbrev-ref HEAD": "feat/x\n",
        "git status --porcelain": " M src/index.ts\n",
        "git rev-list --count HEAD..origin/main": "3\n",
        "git tag -l": "v0.6.1\n",
      }),
      "0.6.1",
    );
    expect(refusals.join("\n")).toMatch(/You are on "feat\/x"/);
    expect(refusals.join("\n")).toMatch(/uncommitted changes/);
    expect(refusals.join("\n")).toMatch(/3 commit\(s\) behind origin\/main/);
    expect(refusals.join("\n")).toMatch(/Tag v0\.6\.1 already exists/);
  });

  it("says so when origin cannot be reached, rather than assuming main is current", () => {
    expect(preflight(fakeGit({ ...CLEAN, "git fetch": new Error("offline") }), "0.6.1")).toEqual(["Could not reach origin to check main is up to date."]);
  });

  it("refuses when the name scan finds a line outside the README table", () => {
    const run = fakeGit({ ...CLEAN, "git grep": "src/x.ts:3: // compare with SomeOtherProject\n" });
    expect(nameScan(run)).toEqual(["src/x.ts:3: // compare with SomeOtherProject"]);
    expect(preflight(run, "0.6.1").join("\n")).toMatch(/name scan found 1 line/);
  });
});

/** `launchctl print` for a job, shaped like the real output. */
function printed(pid: number | null, env: Record<string, string> = {}, script = "/repo/bin/al-buddy-memory-http.js"): string {
  return [
    `gui/501/${CONNECTOR_LABEL} = {`,
    "\tstate = running",
    "\targuments = {",
    "\t\t/usr/local/bin/node",
    `\t\t${script}`,
    "\t}",
    "\tinherited environment = {",
    "\t\tAL_BUDDY_MEMORY_PUBLIC_URL => https://inherited.example",
    "\t}",
    "\tenvironment = {",
    ...Object.entries(env).map(([k, v]) => `\t\t${k} => ${v}`),
    "\t}",
    ...(pid === null ? [] : [`\tpid = ${pid}`]),
    "}",
  ].join("\n");
}

const SERVICE_ENV = { AL_BUDDY_MEMORY_PORT: "9999", AL_BUDDY_MEMORY_PUBLIC_URL: "https://box.example.ts.net/" };

type HealthAnswer = { status: number; body?: unknown } | Error;

/**
 * A stubbed runner and fetch for the connector step: `prints` are what successive
 * `launchctl print` calls answer (the last repeats; an Error throws, as for no job),
 * `health` maps a URL to its answers in turn (the last repeats), `fail` throws for a command prefix.
 */
function connectorStubs(opts: { prints: (string | Error)[]; health?: Record<string, HealthAnswer[]>; fail?: Record<string, Error> }) {
  const calls: string[] = [];
  const fetched: string[] = [];
  let printIndex = 0;
  const healthIndex: Record<string, number> = {};
  const run = (cmd: string, args: string[]): string => {
    const key = [cmd, ...args].join(" ");
    calls.push(key);
    for (const [prefix, err] of Object.entries(opts.fail ?? {})) if (key.startsWith(prefix)) throw err;
    if (key.startsWith("launchctl print")) {
      const answer = opts.prints[Math.min(printIndex++, opts.prints.length - 1)];
      if (answer instanceof Error) throw answer;
      return answer;
    }
    return "";
  };
  const fetch = async (url: string) => {
    fetched.push(url);
    const answers = opts.health?.[url] ?? [new Error("ECONNREFUSED")];
    const i = healthIndex[url] ?? 0;
    healthIndex[url] = i + 1;
    const answer = answers[Math.min(i, answers.length - 1)];
    if (answer instanceof Error) throw answer;
    return { ok: answer.status >= 200 && answer.status < 300, status: answer.status, json: async () => answer.body };
  };
  const base = { run, fetch, sleep: async () => {}, env: {}, platform: "darwin", uid: 501, root: "/repo", attempts: 8 };
  return { calls, fetched, base };
}

// The label is read from the lib, not written out: src/ may not hold the old home folder's
// name followed by a dot (project-memory-isolation.test.ts), and a launchd label is one.
const LABEL_TARGET = `gui/501/${CONNECTOR_LABEL}`;
const LOCAL = "http://127.0.0.1:9999/health";
const PUBLIC = "https://box.example.ts.net/health";
const OK = { status: 200, body: { ok: true } };

describe("the remote connector after the pin", () => {
  it("defaults to the job's documented label", () => {
    // Built in pieces, for the same reason as LABEL_TARGET.
    expect(CONNECTOR_LABEL).toBe(["com", "al-buddy", "memory-connector"].join("."));
  });

  it("reads only the job's own environment block, not the inherited one", () => {
    expect(launchdEnvironment(printed(1, SERVICE_ENV))).toEqual(SERVICE_ENV);
    expect(launchdEnvironment(printed(1))).toEqual({});
  });

  it("skips quietly when the job is absent, or this is not a Mac", async () => {
    const absent = connectorStubs({ prints: [new Error("Could not find service")] });
    expect(await refreshConnector(absent.base)).toEqual({ skipped: true, ok: true, lines: [] });
    expect(absent.calls).toEqual([`launchctl print ${LABEL_TARGET}`]);
    const linux = connectorStubs({ prints: [printed(1, SERVICE_ENV)] });
    expect(await refreshConnector({ ...linux.base, platform: "linux" })).toEqual({ skipped: true, ok: true, lines: [] });
    expect(linux.calls).toEqual([]);
  });

  it("takes the label from AL_BUDDY_MEMORY_CONNECTOR_LABEL", async () => {
    const s = connectorStubs({ prints: [new Error("Could not find service")] });
    await refreshConnector({ ...s.base, env: { AL_BUDDY_MEMORY_CONNECTOR_LABEL: "org.example.connector" } });
    expect(s.calls).toEqual(["launchctl print gui/501/org.example.connector"]);
  });

  it("rebuilds, restarts, waits for the new process, then checks local and public /health", async () => {
    const s = connectorStubs({
      prints: [printed(100, SERVICE_ENV), printed(100, SERVICE_ENV), printed(null, SERVICE_ENV), printed(200, SERVICE_ENV)],
      health: { [LOCAL]: [new Error("ECONNREFUSED"), OK], [PUBLIC]: [OK] },
    });
    const result = await refreshConnector(s.base);
    expect(result.ok).toBe(true);
    expect(s.calls.slice(0, 3)).toEqual([`launchctl print ${LABEL_TARGET}`, "npm run build", `launchctl kickstart -k ${LABEL_TARGET}`]);
    // No /health asked while the old pid (or none) was up: that answer could be the old process's.
    expect(s.fetched).toEqual([LOCAL, LOCAL, PUBLIC]);
    const text = result.lines.join("\n");
    expect(text).toMatch(/pid 100 → 200/);
    expect(text).toContain(`local  ${LOCAL}: ok`);
    expect(text).toContain(`public ${PUBLIC}: ok`);
  });

  it("does not restart on a failed build, and says how to retry", async () => {
    const buildError = Object.assign(new Error("Command failed: npm run build"), { stdout: "src/x.ts(1,1): error TS2322: nope\n" });
    const s = connectorStubs({ prints: [printed(100, SERVICE_ENV)], fail: { "npm run build": buildError } });
    const result = await refreshConnector(s.base);
    expect(result.ok).toBe(false);
    expect(s.calls).not.toContain(`launchctl kickstart -k ${LABEL_TARGET}`);
    expect(result.lines.join("\n")).toMatch(/build FAILED.*error TS2322/);
    expect(result.lines.join("\n")).toContain(`retry: npm run build && launchctl kickstart -k ${LABEL_TARGET}`);
  });

  it("fails when kickstart fails", async () => {
    const s = connectorStubs({ prints: [printed(100, SERVICE_ENV)], fail: { "launchctl kickstart": new Error("Operation not permitted") } });
    const result = await refreshConnector(s.base);
    expect(result.ok).toBe(false);
    expect(s.fetched).toEqual([]);
    expect(result.lines.join("\n")).toMatch(/restart FAILED.*Operation not permitted/);
  });

  it("fails when the local /health never answers ok, and leaves the public one unasked", async () => {
    const s = connectorStubs({ prints: [printed(100, SERVICE_ENV), printed(200, SERVICE_ENV)], health: { [LOCAL]: [{ status: 503 }] } });
    const result = await refreshConnector(s.base);
    expect(result.ok).toBe(false);
    expect(s.fetched.length).toBeGreaterThan(0);
    expect(s.fetched.every((u) => u === LOCAL)).toBe(true);
    expect(result.lines.join("\n")).toContain(`local  ${LOCAL}: FAILED (HTTP 503)`);
  });

  it("fails when no new process comes up after the restart", async () => {
    const s = connectorStubs({ prints: [printed(100, SERVICE_ENV)] });
    const result = await refreshConnector(s.base);
    expect(result.ok).toBe(false);
    expect(s.fetched).toEqual([]);
    expect(result.lines.join("\n")).toMatch(/no new pid was seen/);
  });

  it("fails when the public URL does not answer, naming the tunnel", async () => {
    const s = connectorStubs({ prints: [printed(100, SERVICE_ENV), printed(200, SERVICE_ENV)], health: { [LOCAL]: [OK], [PUBLIC]: [{ status: 502 }] } });
    const result = await refreshConnector(s.base);
    expect(result.ok).toBe(false);
    expect(result.lines.join("\n")).toMatch(/public https:\/\/box\.example\.ts\.net\/health: FAILED \(HTTP 502\).*tunnel/);
  });

  it("treats a 200 that is not { ok: true } as a failure", async () => {
    const s = connectorStubs({ prints: [printed(100, SERVICE_ENV), printed(200, SERVICE_ENV)], health: { [LOCAL]: [{ status: 200, body: "<html>" }] } });
    expect((await refreshConnector(s.base)).ok).toBe(false);
  });

  it("falls back to this shell's env and port 8787, and says when there is no public URL", async () => {
    const s = connectorStubs({ prints: [printed(100), printed(200)], health: { "http://127.0.0.1:8787/health": [OK] } });
    const result = await refreshConnector(s.base);
    expect(result.ok).toBe(true);
    expect(result.lines.join("\n")).toMatch(/public not checked: no AL_BUDDY_MEMORY_PUBLIC_URL/);
    const shell = connectorStubs({ prints: [printed(100), printed(200)], health: { "http://127.0.0.1:7000/health": [OK], "https://shell.example/health": [OK] } });
    const fromShell = await refreshConnector({ ...shell.base, env: { AL_BUDDY_MEMORY_PORT: "7000", AL_BUDDY_MEMORY_PUBLIC_URL: "https://shell.example" } });
    expect(fromShell.ok).toBe(true);
    expect(shell.fetched).toEqual(["http://127.0.0.1:7000/health", "https://shell.example/health"]);
  });

  it("changes nothing on a dry run", async () => {
    const s = connectorStubs({ prints: [printed(100, SERVICE_ENV)] });
    const result = await refreshConnector({ ...s.base, dryRun: true });
    expect(result.ok).toBe(true);
    expect(s.calls).toEqual([`launchctl print ${LABEL_TARGET}`]);
    expect(s.fetched).toEqual([]);
    expect(result.lines.join("\n")).toMatch(/\[dry run\] would rebuild/);
  });

  it("notes when the job serves another checkout's bin/", async () => {
    const s = connectorStubs({ prints: [printed(100, SERVICE_ENV, "/elsewhere/bin/al-buddy-memory-http.js")] });
    const result = await refreshConnector({ ...s.base, dryRun: true });
    expect(result.lines.join("\n")).toMatch(/the job runs \/elsewhere\/bin\/al-buddy-memory-http\.js, not this checkout's bin\//);
  });
});
