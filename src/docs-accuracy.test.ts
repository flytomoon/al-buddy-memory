import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The docs are part of the product, and three of them said something the code
 * does not do (Fable 5.1 MCP-surface review, 2026-09-19). Links are covered by
 * `docs-links.test.ts`; this file covers claims — the small number of places
 * where a sentence is a promise a reader will check.
 */
const root = join(dirname(new URL(import.meta.url).pathname), "..");
const read = (f: string) => readFileSync(join(root, f), "utf8");

describe("docs — the claims a reader will check", () => {
  /**
   * STARTER.md built a governed handle in step 2 and then handed `consolidate`
   * the RAW store in step 3, so every derived fact bypassed policy and audit.
   * Measured on this code, 2026-09-19, with `personalDefaults({owner:"maya"})`
   * and a proposal restating a password out of a raw turn: through the raw
   * store the derived fact is written `Private` with 0 audit events; through the
   * governed handle it is written `Sensitive` with 8. The raw-store PINS in
   * step 1 are left alone — seeding the spine before any policy exists is a
   * deliberate operator action, and it is the same store either way.
   */
  it("STARTER.md consolidates through the governed handle, not the raw store", () => {
    const starter = read("docs/STARTER.md");
    const call = starter.match(/await consolidate\((\w+),/);
    expect(call?.[1]).toBe("governed");
    expect(starter).toMatch(/audit|policy|governed handle/i);
  });

  /**
   * The README blamed the brute-force scan for the semantic path's cost. The
   * scan is 85–127 ms at 100,000 facts; the cost is reading 8 KB text rows and
   * JSON-parsing them, 95–96% of the work. Which is why BLOB is the move and
   * `sqlite-vec` is not, at this size. Two runs are quoted as a range — the
   * reviewer's (1,182 / 1,418 / 85 / 4,170) and ours on 2026-09-19 (978 / 1,744
   * / 127 / 3,650) — because one laptop run is not a constant and a reader who
   * benchmarks us will get a third set.
   */
  it("the README's semantic-path section blames the read and the parse, not the scan", () => {
    const readme = read("README.md");
    // The 2026-09-19 stage timings stay as history: they are why float32 storage was the fix.
    for (const number of [/978–1,182 ms/, /1,418–1,744 ms/, /85–127 ms/]) {
      expect(readme).toMatch(number);
    }
    // Float32 storage shipped in 0.8.1; the README reports what was measured, not a projection of it.
    for (const number of [/1,536 bytes/, /277 MB/, /1,619 ms/]) expect(readme).toMatch(number);
    expect(readme).not.toMatch(/neither is built/);
    expect(readme).not.toMatch(/sqlite-vec.*is the obvious next move/);
  });

  /**
   * Restoring a SQLite file while the WAL still sits beside it replays the WAL
   * over the restore and silently undoes it; WAL mode across two machines on a
   * synced folder corrupts the file. Neither is our bug and both lose a
   * person's memory, so the limits section has to say so.
   */
  it("the README tells you how to restore a backup, and what never to sync", () => {
    const readme = read("README.md");
    expect(readme).toMatch(/## .*Backups, restores and synced folders|### Backups, restores and synced folders/);
    expect(readme).toMatch(/-wal/);
    expect(readme).toMatch(/-shm/);
    for (const service of [/iCloud/, /Dropbox/, /OneDrive/, /Google Drive/]) expect(readme).toMatch(service);
  });

  /**
   * In the Claude apps a connector is used only when something tells it to:
   * in the founder's test (2026-10-11) Claude wrote memory only when asked,
   * server instructions notwithstanding. The "Make it automatic" step gives
   * people one instruction to paste. The page's copy button and the README
   * must carry the same text, and it may name only tools and provenance
   * values the server really has.
   */
  it("the Make-it-automatic instruction is one text, naming only what the server has", async () => {
    const text = read("docs/demo/claude.html").match(/<pre class="plain" id="auto-instruction">([^<]+)<\/pre>/)?.[1];
    expect(text).toMatch(/^Use Al Buddy memory automatically, without being asked\./);
    expect(read("README.md")).toContain(`\n${text}\n`);
    const { TOOL_ANNOTATIONS } = await import("./mcp/governance-server.js");
    for (const tool of ["recall", "remember", "invalidate"]) {
      expect(text).toMatch(new RegExp(`\\b${tool}\\b`));
      expect(TOOL_ANNOTATIONS).toHaveProperty(tool);
    }
    expect(TOOL_ANNOTATIONS).toHaveProperty("unpin");
    expect(read("src/mcp/governance-server.ts")).toMatch(/provenance: z\.enum\(\[[^\]]*"UserInput", "AIInferred"/);
    expect(text).toMatch(/UserInput[^.]*AIInferred/);
  });

  /**
   * The README listed "read audit" as enterprise-only while the public Postgres
   * store ships `accessAudit: { sink, reads: true }` (Fable review, 2026-10-13).
   * Each public seam is named by what EXTENSION-POINTS.md documents, so it
   * cannot be claimed here without first leaving that page.
   */
  it("the README's enterprise-only list holds nothing EXTENSION-POINTS.md says is public", () => {
    const section = read("README.md").match(/\n## Enterprise edition\n([\s\S]*?)\n## /)?.[1] ?? "";
    const enterpriseOnly = [...section.matchAll(/^- (.+)$/gm)].map((m) => m[1]!);
    expect(enterpriseOnly.length).toBeGreaterThan(0);

    const points = read("docs/EXTENSION-POINTS.md");
    const publicSeams = [
      { documented: /accessAudit: \{ sink, reads: true \}/, claimedAs: /\bread audit|access audit|audit sink|StoreAuditSink|accessAudit/i },
      { documented: /## `QueryExecutor`/, claimedAs: /\bQueryExecutor\b|executor interface/i },
      { documented: /## `LockProvider`/, claimedAs: /\bLockProvider\b|lock provider/i },
      { documented: /## `readBoundary`/, claimedAs: /\breadBoundary\b|read boundar/i },
    ];
    for (const { documented, claimedAs } of publicSeams) {
      expect(points).toMatch(documented);
      for (const item of enterpriseOnly) expect(item).not.toMatch(claimedAs);
    }
  });

  /**
   * README and SECURITY.md said "one runtime dependency" while `pg` sat in
   * `dependencies` and the Postgres store imported it at load (Fable review,
   * 2026-10-13, M3). Both now name the one and the optional rest; this holds
   * them to package.json. That the main entry loads none of the optional ones
   * is `entry-deps.test.ts`.
   */
  it("README and SECURITY.md name the one runtime dependency, and the optional ones are optional", () => {
    const pkg = JSON.parse(read("package.json")) as { dependencies?: Record<string, string>; optionalDependencies?: Record<string, string> };
    expect(Object.keys(pkg.dependencies ?? {})).toEqual(["better-sqlite3"]);
    const optional = Object.keys(pkg.optionalDependencies ?? {});
    for (const name of ["pg", "@modelcontextprotocol/sdk", "@huggingface/transformers"]) expect(optional).toContain(name);

    const readme = read("README.md");
    expect(readme).toMatch(/One runtime dependency \(`better-sqlite3`/);
    expect(readme).toMatch(/Postgres \(`pg`\), the MCP SDK and the on-device model \(transformers\.js\) are optional/);
    expect(readme).toMatch(/npm install --omit=optional/);
    const security = read("SECURITY.md");
    expect(security).toMatch(/one runtime dependency \(better-sqlite3\)/);
    expect(security).toMatch(/Postgres \(`pg`\), the MCP SDK\s+and the on-device model are optional/);
  });

  /**
   * The README said remote apps get the pinned rules "with their first
   * `recall`", while every HTTP request built its own tool layer, so every
   * recall was the first and carried the whole tier (Fable review, 2026-10-13,
   * M4). It now says first after signing in, and again after the rules change.
   * This holds that to the ledger the connector shares between requests, and to
   * the connector forgetting an app's delivery when it signs in. Over real HTTP
   * it is `http-server.test.ts`.
   */
  it("the README's remote apps get the pins on their first recall after signing in, and after the rules change", async () => {
    expect(read("README.md")).toMatch(/remote apps get those rules with their first `recall` after signing in, and again with the next\s+one after the rules change/);

    const { InMemoryStore } = await import("./in-memory-store.js");
    const { governanceTools, PinDeliveries } = await import("./mcp/governance-server.js");
    const store = new InMemoryStore();
    const local = governanceTools({ store, pinning: true });
    await local.pin({ text: "never a yes-person" });
    // As the connector serves it: one ledger, the app the request came through, pinning off.
    const deliveries = new PinDeliveries();
    let app = "claude";
    const remote = governanceTools({ store, pinning: false, pinDeliveries: deliveries, connection: () => app });
    expect(await remote.pinnedPreamble()).toContain("never a yes-person"); // first recall
    expect(await remote.pinnedPreamble()).toBe("");
    app = "chatgpt";
    expect(await remote.pinnedPreamble()).toContain("never a yes-person"); // another app's first
    app = "claude";
    await local.pin({ text: "dates as YYYY-MM-DD" });
    expect(await remote.pinnedPreamble()).toContain("YYYY-MM-DD"); // the next after the rules change
    expect(await remote.pinnedPreamble()).toBe("");
    deliveries.forget("claude"); // what the connector does when the app signs in again
    expect(await remote.pinnedPreamble()).toContain("never a yes-person");

    const connector = read("src/mcp/http-server.ts");
    expect(connector).toMatch(/onSignIn: \(clientId\) => \{ deliveries\.forget\(clientId\); \}/);
    expect(connector).toMatch(/connection: auth\?\.clientId/);
  });

  /**
   * SIGN-IN.md's team-memory section promises three things about the helper
   * it wires in: `self` is `user:<actor>`, each group is written `team:<group>`
   * so a group's name cannot reach anything else, and a server write is the
   * writer's own. Over real HTTP it is `mcp/http-oidc-team-memory.test.ts`.
   */
  it("SIGN-IN.md's team memory: self from the actor, every group a team, and a write is the writer's own", async () => {
    const signIn = read("docs/SIGN-IN.md");
    expect(signIn).toMatch(/teamMemoryAttributes\(who\.actor, who\.attributes\)/);
    expect(signIn).toMatch(/adds `self`\s+\(`user:<actor>`, from the actor claim\) and writes each group as `team:<group>`/);
    expect(signIn).toMatch(/stamped as theirs \(`scope: "user:<actor>"`,\s+`author: "<actor>"`\)/);

    const { teamMemory, teamMemoryAttributes } = await import("./governance/samples.js");
    const attributes = teamMemoryAttributes("alice", { teams: ["blue", "org", "user:bob"], self: "user:bob" });
    expect(attributes).toEqual({ teams: ["team:blue", "team:org", "team:user:bob"], self: "user:alice" });
    const written = await teamMemory().beforeWrite!({ contextualMetadata: {} } as never, { actor: "alice", purpose: "write", attributes, now: new Date() });
    expect(written.contextualMetadata).toEqual({ scope: "user:alice", author: "alice" });
  });
});
