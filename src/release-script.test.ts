// The release command's pure parts (scripts/release-lib.mjs): every refusal is
// tested here, so a release cannot half-happen for a reason nobody checked.
import { describe, expect, it } from "vitest";

// @ts-expect-error — a plain .mjs script with no type declarations
import * as lib from "../scripts/release-lib.mjs";

const { nextVersion, unreleasedVersion, dateChangelog, releaseSummary, setVersion, pinnedVersion, movePin, preflight, nameScan } = lib as {
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
