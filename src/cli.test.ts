import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CONTEXT_MAX_CHARS, exportMemory, formatStatus, importMemory, memoryDbPath, memoryStatus, semanticAvailability, sessionContext, writeNewFile } from "./cli.js";
import { governanceTools, serverStore } from "./mcp/governance-server.js";
import { SqliteMemoryStore } from "./sqlite-memory-store.js";
import { storeAudit } from "./governance/audit.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "abm-cli-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Write facts the way the MCP server does: through the governed handle, as the assistant. */
async function seed(db: string, texts: string[], pins: string[] = []): Promise<void> {
  const inner = new SqliteMemoryStore(db);
  const t = governanceTools({ store: serverStore(inner, { audit: storeAudit(inner) }) });
  for (const text of texts) await t.remember({ text });
  for (const text of pins) await t.pin({ text });
  inner.close();
}

describe("memoryDbPath", () => {
  it("is the MCP server's default unless AL_BUDDY_MEMORY_DB says otherwise", () => {
    expect(memoryDbPath({})).toMatch(/\.al-buddy-memory[\\/]brain\.db$/);
    expect(memoryDbPath({ AL_BUDDY_MEMORY_DB: "/x/y.db" })).toBe("/x/y.db");
    expect(memoryDbPath({ AL_BUDDY_MEMORY_DB: "  " })).toMatch(/brain\.db$/);
  });
});

describe("export and import — the owner's backup round-trips", () => {
  it("exports every fact, Sensitive included, and imports it into an empty database", async () => {
    const db = join(dir, "a.db");
    await seed(db, ["Prefers tea", "the wifi password is hunter2"]);
    const text = await exportMemory({ db });
    const artifact = JSON.parse(text);
    expect(artifact.formatVersion).toBeTruthy();
    expect(artifact.projects[0].nodes.map((n: { content: { text: string } }) => n.content.text).sort()).toEqual(["Prefers tea", "the wifi password is hunter2"]);

    const file = join(dir, "backup.json");
    writeNewFile(file, text);
    expect(() => writeNewFile(file, text)).toThrow(/already exists/);
    const restored = join(dir, "b.db");
    expect(await importMemory({ db: restored, file })).toEqual({ nodes: 2, edges: 0 });
    // Idempotent: the same artifact again changes nothing.
    expect(await importMemory({ db: restored, file })).toEqual({ nodes: 2, edges: 0 });
    const again = JSON.parse(await exportMemory({ db: restored }));
    expect(again.projects[0].nodes).toEqual(artifact.projects[0].nodes);
  });

  it("the Markdown mirror lists current facts", async () => {
    const db = join(dir, "a.db");
    await seed(db, ["Prefers tea"]);
    expect(await exportMemory({ db, format: "markdown" })).toMatch(/- Prefers tea/);
  });

  it("refuses a database that does not exist rather than creating one", async () => {
    const db = join(dir, "none.db");
    await expect(exportMemory({ db })).rejects.toThrow(/no memory at/);
    expect(existsSync(db)).toBe(false);
  });

  it("refuses a malformed artifact before writing anything", async () => {
    const file = join(dir, "bad.json");
    writeFileSync(file, JSON.stringify({ formatVersion: "1.1.0", projects: [{ project: "p", nodes: [{ nodeId: 1 }], edges: [] }], mcp: { entities: [], relations: [] } }));
    const db = join(dir, "c.db");
    await expect(importMemory({ db, file })).rejects.toThrow();
    const inner = new SqliteMemoryStore(db);
    expect(await inner.listNodes()).toHaveLength(0);
    inner.close();
  });
});

describe("context — the session-start briefing", () => {
  const now = new Date("2030-01-01T00:00:00Z");

  it("prints nothing, and creates nothing, when there is no memory yet", async () => {
    const db = join(dir, "none.db");
    expect(await sessionContext({ db, cwd: "/work/al-buddy" })).toBe("");
    expect(existsSync(db)).toBe(false);
  });

  it("shows pins, facts mentioning the project, and recent facts — never a Sensitive one", async () => {
    const db = join(dir, "a.db");
    await seed(db, ["Gardenbot uses SQLite for storage", "Prefers tea", "the wifi password is hunter2"], ["Always answer in British English"]);
    const out = await sessionContext({ db, cwd: "/home/me/Gardenbot", now });
    expect(out).toMatch(/Long-term memory \(al-buddy-memory\): 2 current facts/);
    expect(out).toMatch(/Always answer in British English/);
    expect(out).toMatch(/Facts mentioning "Gardenbot":\n- Gardenbot uses SQLite/);
    expect(out).toMatch(/Most recently learned:\n- Prefers tea/);
    expect(out).not.toMatch(/hunter2/);
    // The fact shown under the project is not repeated under "recent".
    expect(out.match(/Gardenbot uses SQLite/g)).toHaveLength(1);
  });

  it("stays inside its budget and never cuts a line in half", async () => {
    const db = join(dir, "a.db");
    await seed(db, Array.from({ length: 30 }, (_, i) => `Fact number ${i} ${"about many things ".repeat(12)}`));
    const out = await sessionContext({ db, cwd: "/x/y", maxChars: 600, now });
    expect(out.length).toBeLessThanOrEqual(600);
    for (const line of out.split("\n").filter((l) => l.startsWith("- "))) expect(line).toMatch(/\(since \d{4}-\d{2}-\d{2}, id [^)]+\)$/);
    const capped = await sessionContext({ db, cwd: "/x/y", maxChars: 1_000_000, now });
    expect(capped.length).toBeLessThanOrEqual(CONTEXT_MAX_CHARS);
  });
});

describe("status — what is remembered, where, and whether recall reads meaning", () => {
  const on = { state: "on" as const, detail: "model ready in /m" };

  it("reports nothing yet, and creates nothing, when there is no memory", async () => {
    const db = join(dir, "none.db");
    const s = await memoryStatus({ db, semantic: on });
    expect(s).toMatchObject({ exists: false, current: 0, lastWrite: null });
    expect(existsSync(db)).toBe(false);
    expect(formatStatus(s)).toMatch(/^Memory: none yet at /);
  });

  it("counts current, retired and pinned facts and the last write — and prints no fact's text", async () => {
    const db = join(dir, "a.db");
    await seed(db, ["Prefers tea", "Lives in Tokyo", "the wifi password is hunter2"], ["Always answer in British English"]);
    const inner = new SqliteMemoryStore(db);
    const t = governanceTools({ store: serverStore(inner, { audit: storeAudit(inner) }) });
    const [tokyo] = (await t.recall({ query: "Tokyo" })).filter((r: { text: string }) => r.text === "Lives in Tokyo");
    await t.invalidate({ id: tokyo!.id, reason: "moved" });
    inner.close();

    const s = await memoryStatus({ db, semantic: on });
    expect(s).toMatchObject({ exists: true, current: 2, retired: 1, pinned: 1, indexed: 0 });
    expect(s.sizeBytes).toBeGreaterThan(0);
    expect(Date.parse(s.lastWrite!)).toBeGreaterThan(Date.now() - 60_000);
    const text = formatStatus(s);
    expect(text).toMatch(/Facts: 2 current facts, 1 retired \(kept in history\), 1 pinned rule/);
    expect(text).toMatch(/Semantic search: on — model ready in \/m; 0 of 4 facts indexed so far/);
    expect(text).not.toMatch(/tea|Tokyo|hunter2|British/);
  });

  it("says why semantic search is off: switched off, Intel Mac, runtime missing, model not downloaded", () => {
    const base = { platform: "darwin", arch: "arm64", modelCacheDir: dir, hasRuntime: () => true };
    expect(semanticAvailability({ ...base, env: { AL_BUDDY_MEMORY_SEMANTIC: "off" } }).state).toBe("off");
    expect(semanticAvailability({ ...base, env: {}, arch: "x64" })).toMatchObject({ state: "unavailable", detail: expect.stringMatching(/Intel Mac/) });
    expect(semanticAvailability({ ...base, env: {}, hasRuntime: () => false })).toMatchObject({ state: "unavailable", detail: expect.stringMatching(/not installed/) });
    expect(semanticAvailability({ ...base, env: {} })).toMatchObject({ state: "not-downloaded", detail: expect.stringMatching(/90 MB/) });
    mkdirSync(join(dir, "Xenova", "all-MiniLM-L6-v2"), { recursive: true });
    expect(semanticAvailability({ ...base, env: {} }).state).toBe("on");
  });
});
