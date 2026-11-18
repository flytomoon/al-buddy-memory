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
  it("pins the README's valid-time and current-state benchmark claims to code", () => {
    const readme = read("README.md").replace(/\s+/g, " ");
    expect(readme).toContain("`recordState` closes a late-learned state at the next state in valid-time order");
    expect(read("src/state.ts")).toMatch(/const later = states\.filter\(\(n\) => n\.validFrom > when\)/);
    expect(readme).toContain("recall uses the declared subject/aspect for current-state intent");
    expect(read("src/hybrid-retriever.ts")).toMatch(/searchNodes\(\{ tags: \[STATE_TAG\], validAt/);
    expect(read("src/hybrid-retriever.ts")).toMatch(/if \(options\.stateIntent\)/);
    expect(read("bench/stale-facts/stale-facts.mjs")).toMatch(/validAt: q\.validAt, contentWords: true, expand: true, stateIntent: true,/);
  });
  it("README quick start names the clients and local behavior init actually configures", () => {
    const readme = read("README.md");
    const quick = readme.match(/## Quick start — local MCP memory\n([\s\S]*?)\n---/)?.[1] ?? "";
    expect(quick).toMatch(/npx -y al-buddy-memory init/);
    for (const client of ["Claude Code", "Cursor", "Codex"]) expect(quick).toContain(client);
    expect(quick).toMatch(/brain\.db/);
    expect(quick).toMatch(/keyword recall/);
    const init = read("bin/init.js");
    expect(init).toMatch(/\.cursor", "mcp\.json"/);
    expect(init).toMatch(/configureCli\("claude"/);
    expect(init).toMatch(/configureCli\("codex"/);
    expect(init).toMatch(/AL_BUDDY_MEMORY_SEMANTIC: "off"/);
    expect(read("bin/al-buddy-memory.js")).toMatch(/if \(cmd === "init"\)/);
    expect(JSON.parse(read("package.json")).scripts.check).toMatch(/build && npm test$/);
  });
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
   * The README's tool list is every tool the server registers, and it says a
   * host adds its own with `registerTools`: called once per server, after the
   * core's tools, so a name of theirs is refused rather than replaced.
   */
  it("the README lists exactly the server's tools, and a host's own come after them", async () => {
    const line = read("README.md").match(/^Tools: (.+)$/m)?.[1] ?? "";
    const named = [...line.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]!);
    const { TOOL_ANNOTATIONS } = await import("./mcp/governance-server.js");
    expect([...new Set(named)].sort()).toEqual(Object.keys(TOOL_ANNOTATIONS).sort());
    expect(line).toMatch(/`confirm_retraction` acknowledges a transcript correction while keeping the retracted fact and raw turn in history/);
    expect(read("src/mcp/governance-server.ts")).toMatch(/server\.tool\("confirm_retraction"[^\n]*Acknowledge a transcript correction/);
    expect(line).toMatch(/A host adds its own tools with `GovernanceDeps\.registerTools`, after these/);
    const server = read("src/mcp/governance-server.ts");
    expect(server.indexOf("deps.registerTools({ server, z, json, deps })")).toBeGreaterThan(server.lastIndexOf('server.tool("export"'));
  });

  it("the README's recall audit growth claim matches read-only recall, opt-in per-hit writes and the MCP cap", () => {
    expect(read("README.md")).toMatch(/A governed `recall` adds read audit events; with `recordAccess` on, also an audited access write for each returned hit \(at most 50 through MCP\)/);
    expect(read("src/hybrid-retriever.ts")).toContain("this.opts.recordAccess === true ? recordRecallHits(this.store, hits) : hits");
    expect(read("src/mcp/governance-server.ts")).toContain("deps.recordAccess === true ? recordRecallHits(deps.store, hits) : hits");
    expect(read("src/access.ts")).toMatch(/store\.recordRecalls\(hits\.map/);
    expect(read("src/mcp/governance-server.ts")).toMatch(/Math\.max\(1, Math\.min\(50, input\.limit \?\? 8\)\)/);
  });

  /**
   * The README's benchmark table has one row per benchmark, each read from the
   * result files it links (founder, 2026-11-18: final scores only). Each
   * score, its judge and its reader must be what the files hold.
   */
  it("the README's benchmark table matches the result files it links", () => {
    const readme = read("README.md");
    const pct = (x: number) => `${(Math.round(x * 1000) / 10).toFixed(1)}%`;
    const section = readme.match(/\n## Benchmarks\n([\s\S]*?)\n## /)?.[1] ?? "";
    const rows = section.split("\n").filter((l) => /^\| \[/.test(l));
    expect(rows).toHaveLength(3);
    const row = (name: string) => rows.find((l) => l.startsWith(`| [${name}]`)) ?? "";
    const json = (f: string) => JSON.parse(read(`bench/results/${f}`));

    // LongMemEval: the official judge's overall, Claude Sonnet reading every question.
    const lme = row("LongMemEval");
    const run = json("2026-09-30-lme-full-fast.json");
    const official = json("2026-09-30-lme-full-fast.hypotheses.eval-gpt-4o-2024-08-06.summary.json");
    expect([run.summary.qa.questions, official.n]).toEqual([500, 500]);
    expect(Object.keys(run.summary.models.answer)).toEqual(["claude-sonnet-5-5"]);
    expect(official.model).toBe("gpt-4o-2024-08-06");
    expect(lme).toContain(`**${pct(official.overall)}**, graded by the official judge (${official.model}); Claude Sonnet 5.5 reads`);
    expect(lme).toContain("(bench/results/2026-09-30-lme-full-fast.json)");
    expect(lme).toContain("(bench/results/2026-09-30-lme-full-fast.hypotheses.eval-gpt-4o-2024-08-06.summary.json)");
    expect(section).toContain(`node bench/longmemeval/run.mjs ${run.settings.expand ? "--expand " : ""}--aggregate-top-k ${run.settings.aggregateTopK} --chain-of-note`);

    // LoCoMo: two runs that together answer every question once.
    const locomo = row("LoCoMo");
    const parts = ["2026-11-18-locomo.summary.json", "2026-11-18-locomo-2.summary.json"].map(json);
    expect(parts.flatMap((p) => p.settings.selection.categories).sort()).toEqual([1, 2, 3, 4, 5]);
    for (const p of parts) {
      expect(p.dirty).toBe(false);
      expect(p.summary.errors).toBe(0);
      expect(Object.keys(p.summary.models.answer)).toEqual(["claude-sonnet-5-5"]);
      expect(Object.keys(p.summary.models.judge)).toEqual(["claude-sonnet-5-5"]);
      expect(p.settings).toMatchObject({ expand: true, contentWords: true, neighbours: 34, topK: 40 });
    }
    const scored = (key: "published" | "corrected") => parts.reduce((s, p) => ({ correct: s.correct + p.summary.scored[key].correct, n: s.n + p.summary.scored[key].n }), { correct: 0, n: 0 });
    const corrected = scored("corrected");
    const published = scored("published");
    expect([corrected.n, published.n]).toEqual([1540, 1540]);
    const adversarial = parts.find((p) => p.summary.adversarial.questions > 0).summary.adversarial;
    expect(adversarial.abstentionJudge.n).toBe(446);
    expect(locomo).toContain(
      `**${pct(corrected.correct / corrected.n)}** on the audit-corrected key, ${pct(published.correct / published.n)} on the published key; abstention ${pct(adversarial.abstentionJudge.accuracy)} on the ${adversarial.abstentionJudge.n} adversarial questions`,
    );
    expect(locomo).toContain("(1,540 scored questions)");
    expect(section).toContain("node bench/locomo/run.mjs --expand --strip-speakers --content-words --neighbours 34 --support-check\n");

    // Stale facts: the current value first, now-questions, recordState.
    const stale = json("2026-11-12-stale-facts.json").summary["current-state"].now;
    expect(row("Stale facts")).toContain(`(${stale.n} questions about now) | **${pct(stale.currentAt1)}** get the current value first, with states recorded through \`recordState\``);
    expect(section).toContain("node bench/stale-facts/run.mjs --embedder local\n");
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
      { documented: /## `GovernedOperations`/, claimedAs: /\bGovernedOperations\b|governed operations/i },
      { documented: /## `registerTools`/, claimedAs: /\bregisterTools\b/i },
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
   * Importing an older backup after any fact changed refused the whole file
   * (Fable review, 2026-10-13, H2). The README, the plugin page and the
   * plugin's /import command now promise the opposite, in one sentence; the
   * sentence holds only while import skips and counts the older copy, prints
   * that count, and leaves an identical one exactly as it was.
   */
  it("import skips and counts facts held in a newer state, and an identical one is a no-op", async () => {
    const claim = "Facts this store already holds in a newer state are skipped and counted; identical ones are no-ops";
    for (const f of ["README.md", "docs/claude-plugin.md", "plugin/commands/import.md"]) {
      expect(read(f).replace(/\s+/g, " ")).toContain(claim);
    }

    const { InMemoryStore } = await import("./in-memory-store.js");
    const { exportPortable, importPortable } = await import("./memory-portability.js");
    const { formatImportSummary } = await import("./cli.js");
    const { makeNode } = await import("./memory-store-conformance.spec.js");
    const store = new InMemoryStore();
    const kept = await store.addNode(makeNode({ content: { text: "Prefers tea" } }));
    const moved = await store.addNode(makeNode({ content: { text: "Lives in Leeds" } }));
    const backup = await exportPortable(new Map([["p", store]]));
    await store.updateNode(moved.nodeId, { validTo: new Date().toISOString() });
    const before = { nodes: await store.listNodes(), kept: await store.history(kept.nodeId), moved: await store.history(moved.nodeId) };

    const summary = await importPortable(backup, () => store);
    expect(summary).toEqual({ nodes: 1, edges: 0, skipped: 1 });
    expect(formatImportSummary(summary, "memory.db")).toMatch(/skipped 1 fact\(s\) already held in a newer state here$/);
    expect(await store.listNodes()).toEqual(before.nodes);
    expect(await store.history(kept.nodeId)).toEqual(before.kept);
    expect(await store.history(moved.nodeId)).toEqual(before.moved);
  });
});
