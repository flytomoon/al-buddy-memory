// The public repo guard (scripts/public-guard-lib.mjs + scripts/public-guard.mjs):
// every rule, the deny list's edge cases, the release preflight wiring, and a
// real `git push` refused by the installed hook.
//
// Every credential-shaped sample here is assembled at runtime from parts, and
// every "private name" is invented, so this file passes the guard it tests.
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

// @ts-expect-error — a plain .mjs script with no type declarations
import * as guardLib from "../scripts/public-guard-lib.mjs";
// @ts-expect-error — a plain .mjs script with no type declarations
import * as releaseLib from "../scripts/release-lib.mjs";

type Hit = { rule: string; match: string; where?: string };
type Run = (cmd: string, args: string[]) => string;
const g = guardLib as {
  denyListPath(env: Record<string, string | undefined>, home: string): string;
  parseDenyList(text: string): string[];
  loadDenyList(readFile: (p: string) => string, path: string): string[];
  scanLine(line: string, names: string[]): Hit[];
  addedLines(patch: string): { file: string; line: number; text: string }[];
  scanCommit(sha: string, message: string, patch: string, names: string[]): Hit[];
  scanCommits(run: Run, revArgs: string[], names: string[]): Hit[];
  scanTreeForNames(run: Run, names: string[]): Hit[];
  parsePrePushInput(text: string): { localRef: string; remoteRef: string; revArgs: string[] }[];
  formatHits(hits: Hit[]): string;
  ALLOW_MARKER: string;
  BUILTIN_RULES: { id: string }[];
};
const { preflight } = releaseLib as { preflight(run: Run, target: string, names?: string[]): string[] };

const NAMES = ["Acme Widgets", "Zorblax"];
const SHA = "a".repeat(40);
const MARKER = "TODO" + "-PRIVATE";

const SAMPLES: Record<string, string> = {
  "private-key-block": "-----BEGIN RSA " + "PRIVATE KEY-----",
  "aws-access-key-id": "AKIA" + "Q7".repeat(8),
  "github-token": "ghp" + "_" + "x".repeat(36),
  "anthropic-key": "sk-" + "ant-" + "api03-" + "y".repeat(30),
  "openai-key": "sk-" + "proj-" + "z".repeat(40),
  "slack-token": "xox" + "b-" + "1234567890-abcdef",
  "google-api-key": "AI" + "za" + "B".repeat(35),
  "stripe-live-key": "sk" + "_live_" + "c".repeat(24),
  "npm-token": "npm" + "_" + "d".repeat(36),
  "telegram-bot-token": "123456789" + ":AA" + "e".repeat(33),
  "private-marker": MARKER,
};

describe("the deny list", () => {
  it("lives outside the repo, in the home directory, unless the env points elsewhere", () => {
    expect(g.denyListPath({}, "/home/u")).toBe("/home/u/.al-buddy-memory/private-names.txt");
    expect(g.denyListPath({ AL_BUDDY_MEMORY_PRIVATE_NAMES: "/x/names.txt" }, "/home/u")).toBe("/x/names.txt");
    expect(g.denyListPath({ AL_BUDDY_MEMORY_PRIVATE_NAMES: "  " }, "/home/u")).toBe("/home/u/.al-buddy-memory/private-names.txt");
  });

  it("drops blanks, comments and duplicates", () => {
    expect(g.parseDenyList("# employer\nAcme Widgets\n\n  Zorblax  \nacme widgets\r\n")).toEqual(["Acme Widgets", "Zorblax"]);
  });

  it("is empty when the file is absent, and throws on any other read failure (fail closed)", () => {
    const missing = () => {
      throw Object.assign(new Error("nope"), { code: "ENOENT" });
    };
    const denied = () => {
      throw Object.assign(new Error("denied"), { code: "EACCES" });
    };
    expect(g.loadDenyList(missing, "/x")).toEqual([]);
    expect(() => g.loadDenyList(denied, "/x")).toThrow(/denied/);
  });
});

describe("one line", () => {
  it("finds a deny-list name case-insensitively, across any whitespace, and reports the exact text", () => {
    expect(g.scanLine("Notes from the ACME  widgets offsite", NAMES)).toEqual([{ rule: "private-name", match: "ACME  widgets" }]);
  });

  it("does not fire on a name inside a longer word", () => {
    expect(g.scanLine("zorblaxian and prezorblax", NAMES)).toEqual([]);
    expect(g.scanLine("zorblax.", NAMES)).toEqual([{ rule: "private-name", match: "zorblax" }]);
  });

  it("with no deny list runs only the built-ins", () => {
    expect(g.scanLine("Acme Widgets", [])).toEqual([]);
  });

  it.each(Object.entries(SAMPLES))("built-in %s fires", (rule, sample) => {
    const hits = g.scanLine(`value = "${sample}"`, []);
    expect(hits.map((h) => h.rule)).toEqual([rule]);
  });

  it("has a sample for every built-in rule", () => {
    expect(Object.keys(SAMPLES).sort()).toEqual(g.BUILTIN_RULES.map((r) => r.id).sort());
  });

  it("masks a credential in the report but shows a marker exactly", () => {
    const [secret] = g.scanLine(SAMPLES["aws-access-key-id"]!, []);
    expect(secret!.match).toBe("AKIAQ7… (20 chars)");
    expect(g.scanLine(MARKER, [])[0]!.match).toBe(MARKER);
  });

  it("leaves ordinary code alone", () => {
    for (const line of ["const sk = 'sk-short';", "ghp_ is a prefix", "see AKIA prefixes in the AWS docs", "-----BEGIN PUBLIC KEY-----", "TODO: tidy"]) {
      expect(g.scanLine(line, NAMES)).toEqual([]);
    }
  });

  it("the allow marker exempts built-ins on that line, never a private name", () => {
    expect(g.scanLine(`${SAMPLES["github-token"]} // ${g.ALLOW_MARKER}`, [])).toEqual([]);
    expect(g.scanLine(`Zorblax // ${g.ALLOW_MARKER}`, NAMES)).toEqual([{ rule: "private-name", match: "Zorblax" }]);
  });
});

const PATCH = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 111..222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -3,0 +4,2 @@",
  "+const ok = 1;",
  "+// ask Zorblax",
  "@@ -10 +12 @@",
  "-const gone = 'Acme Widgets';",
  "+const kept = 2;",
  "diff --git a/docs/acme-widgets.md b/docs/acme-widgets.md",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/docs/acme widgets.md",
  "@@ -0,0 +1 @@",
  "+hello",
].join("\n");

describe("a commit", () => {
  it("reads only added lines, with their real line numbers, plus the changed paths", () => {
    expect(g.addedLines(PATCH)).toEqual([
      { file: "src/a.ts", line: 0, text: "src/a.ts" },
      { file: "src/a.ts", line: 4, text: "const ok = 1;" },
      { file: "src/a.ts", line: 5, text: "// ask Zorblax" },
      { file: "src/a.ts", line: 12, text: "const kept = 2;" },
      { file: "docs/acme widgets.md", line: 0, text: "docs/acme widgets.md" },
      { file: "docs/acme widgets.md", line: 1, text: "hello" },
    ]);
  });

  it("reports each hit with the commit, the file:line or message line, the rule and the match", () => {
    const hits = g.scanCommit(SHA, `Fix the thing\n\nAs Zorblax asked. ${MARKER}`, PATCH, NAMES);
    expect(g.formatHits(hits).split("\n").map((l) => l.trim())).toEqual([
      'commit aaaaaaa message line 3: private-name "Zorblax"',
      `commit aaaaaaa message line 3: private-marker "${MARKER}"`,
      'commit aaaaaaa src/a.ts:5: private-name "Zorblax"',
      'commit aaaaaaa path docs/acme widgets.md: private-name "acme widgets"',
    ]);
  });

  it("does not count a removed line: deleting a name is the fix, not the offence", () => {
    expect(g.scanCommit(SHA, "Remove it", "--- a/x\n+++ b/x\n@@ -1 +0,0 @@\n-Zorblax", NAMES)).toEqual([]);
  });
});

describe("the pre-push input", () => {
  it("scans new commits for an update, everything not on a remote for a new branch, nothing for a deletion", () => {
    const Z = "0".repeat(40);
    const updates = g.parsePrePushInput(
      [`refs/heads/a ${"1".repeat(40)} refs/heads/a ${"2".repeat(40)}`, `refs/heads/b ${"3".repeat(40)} refs/heads/b ${Z}`, `(delete) ${Z} refs/heads/c ${"4".repeat(40)}`, ""].join("\n"),
    );
    expect(updates.map((u) => u.revArgs)).toEqual([[`${"2".repeat(40)}..${"1".repeat(40)}`], ["3".repeat(40), "--not", "--remotes"]]);
  });
});

describe("the release preflight", () => {
  const CLEAN: Record<string, string | Error> = {
    "git rev-parse --abbrev-ref HEAD": "main\n",
    "git status --porcelain": "",
    "git fetch": "",
    "git rev-list --count HEAD..origin/main": "0\n",
    "git tag -l": "",
    "git grep -niE": new Error("exit 1: no matches"),
    "git rev-list origin/main..HEAD": `${SHA}\n`,
    "git log -1 --format=%B": "Release notes\n",
    "git show": "",
    "git grep -n -i -I -F": new Error("exit 1: no matches"),
  };
  const fake =
    (answers: Record<string, string | Error>): Run =>
    (cmd, args) => {
      const key = [cmd, ...args].join(" ");
      for (const [prefix, answer] of Object.entries(answers)) {
        if (key.startsWith(prefix)) {
          if (answer instanceof Error) throw answer;
          return answer;
        }
      }
      return "";
    };

  it("passes a clean release", () => {
    expect(preflight(fake(CLEAN), "0.6.1", NAMES)).toEqual([]);
  });

  it("refuses on a private name in an unpushed commit message, with the exact hit", () => {
    const refusals = preflight(fake({ ...CLEAN, "git log -1 --format=%B": "Notes for Acme Widgets\n" }), "0.6.1", NAMES);
    expect(refusals.join("\n")).toMatch(/public repo guard found 1 hit/);
    expect(refusals.join("\n")).toContain('commit aaaaaaa message line 1: private-name "Acme Widgets"');
  });

  it("refuses on a private name already anywhere in the tree it ships", () => {
    const refusals = preflight(fake({ ...CLEAN, "git grep -n -i -I -F": "docs/x.md:7:thanks to zorblax\n" }), "0.6.1", NAMES);
    expect(refusals.join("\n")).toContain('tree docs/x.md:7: private-name "zorblax"');
  });

  it("says so when it cannot list the commits, rather than passing", () => {
    expect(preflight(fake({ ...CLEAN, "git rev-list origin/main..HEAD": new Error("bad revision") }), "0.6.1", NAMES)).toEqual([
      "The public repo guard could not scan the commits ahead of origin/main (bad revision).",
    ]);
  });
});

// Async spawns only: a synchronous child blocks the vitest worker's RPC for as
// long as git runs, which on a slow disk reads as a hung test file.
type Result = { status: number; stdout: string; stderr: string };
function sh(cmd: string, args: string[], opts: { cwd?: string; env: NodeJS.ProcessEnv }): Promise<Result> {
  return new Promise((resolve) => {
    execFile(cmd, args, { ...opts, encoding: "utf8" }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : 1) : 0;
      resolve({ status: code, stdout, stderr });
    });
  });
}

describe("the hook, against real git", () => {
  const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "public-guard.mjs");
  const dir = mkdtempSync(join(tmpdir(), "public-guard-"));
  const work = join(dir, "work");
  const remote = join(dir, "remote.git");
  const names = join(dir, "private-names.txt");
  const env = {
    ...process.env,
    AL_BUDDY_MEMORY_PRIVATE_NAMES: names,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.com",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.com",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: join(dir, "gitconfig"),
  };
  const git = (...args: string[]) => sh("git", args, { cwd: work, env });
  const guard = (...args: string[]) => sh("node", [SCRIPT, ...args], { cwd: work, env });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("installs as pre-push, lets a clean push through, and refuses one naming a private name", async () => {
    writeFileSync(join(dir, "gitconfig"), "");
    writeFileSync(names, "# invented for the test\nZorblax\n");
    expect((await sh("git", ["init", "-q", "--bare", remote], { env })).status).toBe(0);
    expect((await sh("git", ["init", "-q", "-b", "main", work], { env })).status).toBe(0);
    await git("remote", "add", "origin", remote);
    writeFileSync(join(work, "README.md"), "hello\n");
    await git("add", ".");
    await git("commit", "-qm", "first");

    const install = await guard("--install");
    expect(install.status, install.stderr).toBe(0);
    // The installed hook runs scripts/public-guard.mjs from the repo it lives in;
    // this scratch repo has none, so point it at this checkout's script.
    writeFileSync(join(work, ".git", "hooks", "pre-push"), `#!/bin/sh\nexec node "${SCRIPT}" --pre-push "$@"\n`);

    const clean = await git("push", "-q", "origin", "main");
    expect(clean.status, clean.stderr).toBe(0);

    writeFileSync(join(work, "notes.md"), "hello\nmeeting with zorblax\n");
    await git("add", ".");
    await git("commit", "-qm", "notes");
    const refused = await git("push", "-q", "origin", "main");
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toMatch(/push refused — 1 hit/);
    expect(refused.stderr).toMatch(/commit [0-9a-f]{7} notes\.md:2: private-name "zorblax"/);

    // The manual scan agrees, and with the deny list gone only the built-ins run.
    expect((await guard()).status).toBe(1);
    rmSync(names);
    const builtinsOnly = await guard();
    expect(builtinsOnly.status, builtinsOnly.stderr).toBe(0);
    expect(builtinsOnly.stdout).toMatch(/built-in patterns only/);
  }, 180_000);

  it("refuses to overwrite a pre-push hook that is not its own", async () => {
    writeFileSync(join(work, ".git", "hooks", "pre-push"), "#!/bin/sh\nexit 0\n");
    const r = await guard("--install");
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/already exists and is not this guard's/);
  }, 60_000);
});
