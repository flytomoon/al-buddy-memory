import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));
const internalPaths = [
  ".steward/",
  "docs/internal/",
  "docs/reviews/",
  "docs/research/",
  "docs/DECISION-2026-07-07.md",
  "docs/RESILIENCE-LEDGER.md",
  "docs/SECURITY-REVIEW-2026-10.md",
  "docs/integrations/SUBMISSIONS.md",
  "out/",
];

it.skipIf(!existsSync(new URL("../.git", import.meta.url)))(
  "ignores internal paths and rejects tracked files under them",
  () => {
    const git = (args: string[], input?: string) => execFileSync("git", args, { cwd: root, encoding: "utf8", input });
    const tracked = git(["ls-files", "-z", "--", ...internalPaths]).split("\0").filter(Boolean);
    expect(tracked, "Remove internal files from the public Git index").toEqual([]);

    const probes = internalPaths.map((path) => path.endsWith("/") ? `${path}probe.md` : path);
    const ignored = git(["check-ignore", "--no-index", "-z", "--stdin"], probes.join("\0") + "\0")
      .split("\0").filter(Boolean);
    expect(ignored).toEqual(probes);
  },
);
