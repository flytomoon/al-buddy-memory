import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Three findings of the Fable review (2026-10-13: H1, M3, M5) were sentences in
 * README.md, SECURITY.md or the consent page that the code did not keep. Each
 * was fixed with an assertion in `docs-accuracy.test.ts`; this test makes that
 * the rule rather than the cleanup. A branch that changes one of those claims
 * must change `docs-accuracy.test.ts` too, adding or updating the assertion
 * that pins the claim to code (AGENTS.md, "Docs claims").
 *
 * Only committed changes since the branch left origin/main count: `npm run
 * release:pin` rewrites the README's install line and runs the tests before it
 * commits, and a version pin is not a claim. With no git, no origin/main (CI's
 * shallow checkout), or nothing changed, there is nothing to compare and the
 * test skips or passes.
 */
const root = join(dirname(new URL(import.meta.url).pathname), "..");
type Git = (...args: string[]) => string;
const git: Git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

const CLAIM_FILES = ["README.md", "SECURITY.md", "docs/SIGN-IN.md"];
const CONSENT_FILE = "src/mcp/owner-oauth.ts";
const PIN_FILE = "src/docs-accuracy.test.ts";

/** The merge base with origin/main, or null when git or origin/main is not there. */
function base(): string | null {
  try {
    return git("merge-base", "origin/main", "HEAD").trim() || null;
  } catch {
    return null;
  }
}

/** The 1-based lines of `consentPage` in `text`: from its signature to the method's closing brace. */
function consentPageLines(text: string): [number, number] | null {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => /^ {2}consentPage\(/.test(l));
  if (start < 0) return null;
  const end = lines.findIndex((l, i) => i > start && l === "  }");
  return end < 0 ? null : [start + 1, end + 1];
}

/** Whether a `git diff -U0` touches any line in `range` on the new side. A pure deletion sits just after the line it names. */
function touches(diff: string, [from, to]: [number, number]): boolean {
  for (const m of diff.matchAll(/^@@ -\S+ \+(\d+)(?:,(\d+))? @@/gm)) {
    const start = Number(m[1]);
    const count = m[2] === undefined ? 1 : Number(m[2]);
    if (count === 0 ? from <= start && start < to : start <= to && start + count - 1 >= from) return true;
  }
  return false;
}

/** The claims this branch changed, by file — the consent page counted only when `consentPage` itself changed. */
function changedClaims(git: Git, since: string): { claims: string[]; pinned: boolean } {
  const changed = git("diff", "--name-only", `${since}..HEAD`).split("\n").filter(Boolean);
  const claims = CLAIM_FILES.filter((f) => changed.includes(f));
  if (changed.includes(CONSENT_FILE)) {
    const range = consentPageLines(git("show", `HEAD:${CONSENT_FILE}`));
    if (range === null || touches(git("diff", "-U0", `${since}..HEAD`, "--", CONSENT_FILE), range)) claims.push(`the consent page (${CONSENT_FILE})`);
  }
  return { claims, pinned: changed.includes(PIN_FILE) };
}

describe("docs claims — a changed claim brings its pin", () => {
  it("finds the consent page it guards", () => {
    // If consentPage moves or is renamed, the guard below would treat every change to the file as a claim; say so here.
    expect(consentPageLines(readFileSync(join(root, CONSENT_FILE), "utf8"))).not.toBeNull();
  });

  it("reads hunk ranges: an edit inside, beside, or deleted at the consent page", () => {
    expect(touches("@@ -10,2 +10,3 @@", [11, 20])).toBe(true);
    expect(touches("@@ -30 +30 @@", [11, 20])).toBe(false);
    expect(touches("@@ -5,2 +4,0 @@", [4, 9])).toBe(true);
    expect(touches("@@ -5,2 +4,0 @@", [5, 9])).toBe(false);
    expect(touches("@@ -10,2 +9,0 @@", [5, 9])).toBe(false);
  });

  it("flags a claim file or a consent-page edit without the pin, and nothing else", () => {
    const page = ["class X {", "  consentPage(): string {", "    return `Every change it makes is recorded.`;", "  }", "}"].join("\n");
    const fake = (changed: string[], hunk = ""): Git => (cmd, ...rest) =>
      cmd === "show" ? page : rest[0] === "--name-only" ? `${changed.join("\n")}\n` : hunk;
    expect(changedClaims(fake(["README.md", "src/cli.ts"]), "b")).toEqual({ claims: ["README.md"], pinned: false });
    expect(changedClaims(fake(["docs/SIGN-IN.md", PIN_FILE]), "b")).toEqual({ claims: ["docs/SIGN-IN.md"], pinned: true });
    expect(changedClaims(fake([CONSENT_FILE], "@@ -3 +3 @@\n"), "b").claims).toEqual([`the consent page (${CONSENT_FILE})`]);
    expect(changedClaims(fake([CONSENT_FILE], "@@ -5,0 +5,2 @@\n"), "b").claims).toEqual([]);
    expect(changedClaims(fake(["CONTRIBUTING.md", "docs/STARTER.md"]), "b").claims).toEqual([]);
  });

  it("a branch that changes README, SECURITY, SIGN-IN or the consent page also changes docs-accuracy.test.ts", (ctx) => {
    const since = base();
    if (since === null) ctx.skip();
    const { claims, pinned } = changedClaims(git, since!);
    if (claims.length === 0) return;
    expect(
      pinned,
      `This branch changes ${claims.join(", ")} but not ${PIN_FILE}. Add or update the assertion there that pins the claim to code (AGENTS.md, "Docs claims").`,
    ).toBe(true);
  });
});
