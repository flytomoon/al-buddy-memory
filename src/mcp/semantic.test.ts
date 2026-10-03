import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FakeEmbedder, type Embedder } from "../embedder.js";
import { indexMissingEmbeddings } from "../hybrid-retriever.js";
import { InMemoryStore } from "../in-memory-store.js";
import { EXPORT_INLINE_MAX_BYTES, governanceTools, serverExportView, serverStore } from "./governance-server.js";
import { startSemanticRecall } from "./semantic.js";

const vec = (s: string) => (/tokyo|japan/i.test(s) ? [1, 0] : [0, 1]);
const fact = (text: string) => ({
  provenance: "UserInput" as const,
  encryptionKeyRef: "local",
  memoryType: "Experience" as const,
  privacyClassification: "Private" as const,
  retentionTier: "FullRetention" as const,
  content: { text },
  contextualMetadata: {},
  confidenceWeight: 1,
  decayRate: 0,
  validFrom: "2026-01-01T00:00:00Z",
});

describe("indexMissingEmbeddings — a bounded pass", () => {
  it("embeds at most `limit` facts per pass, and the next pass continues", async () => {
    const store = new InMemoryStore();
    for (let i = 0; i < 5; i += 1) await store.addNode(fact(`fact ${i}`));
    const e = new FakeEmbedder("f", 2, vec);
    expect(await indexMissingEmbeddings(store, e, 2, { limit: 3 })).toBe(3);
    expect(await indexMissingEmbeddings(store, e, 2, { limit: 3 })).toBe(2);
    expect(await indexMissingEmbeddings(store, e, 2, { limit: 3 })).toBe(0);
  });

  it("gives the event loop back while it works, so a server keeps answering (2026-10-03)", async () => {
    const store = new InMemoryStore();
    for (let i = 0; i < 40; i += 1) await store.addNode(fact(`fact ${i}`));
    // Everything here resolves as microtasks: without an explicit yield the whole
    // pass would finish before a single macrotask (a request) got to run.
    let ticks = 0;
    let done = false;
    const tick = () => {
      ticks += 1;
      if (!done) setImmediate(tick);
    };
    setImmediate(tick);
    const indexed = await indexMissingEmbeddings(store, new FakeEmbedder("f", 2, vec), 4);
    done = true;
    expect(indexed).toBe(40);
    expect(ticks).toBeGreaterThanOrEqual(10); // at least once per batch
  });

  it("slices a long run of writes by time, not only between batches", async () => {
    const store = new InMemoryStore();
    for (let i = 0; i < 30; i += 1) await store.addNode(fact(`fact ${i}`));
    let ticks = 0;
    let done = false;
    const tick = () => {
      ticks += 1;
      if (!done) setImmediate(tick);
    };
    setImmediate(tick);
    // One batch of 30, a zero budget: every write is its own slice.
    await indexMissingEmbeddings(store, new FakeEmbedder("f", 2, vec), 30, { sliceMs: 0 });
    done = true;
    expect(ticks).toBeGreaterThanOrEqual(30);
  });

  it("refuses a negative limit", async () => {
    await expect(indexMissingEmbeddings(new InMemoryStore(), new FakeEmbedder("f", 2, vec), 2, { limit: -1 })).rejects.toThrow(/limit/);
  });
});

describe("startSemanticRecall — the server never waits for, or dies on, the model", () => {
  it("is undefined while loading, then ready after the probe, and backfills what was written before", async () => {
    const store = new InMemoryStore();
    await store.addNode(fact("Moved to Tokyo"));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const lines: string[] = [];
    const s = startSemanticRecall({
      load: async () => {
        await gate;
        return new FakeEmbedder("f", 2, vec);
      },
      indexStore: store,
      log: (l) => lines.push(l),
    });
    expect(s.current()).toBeUndefined();
    expect(s.status().state).toBe("loading");
    release();
    const status = await s.settled;
    expect(status).toMatchObject({ state: "ready", model: "f", indexed: 1 });
    expect(s.current()?.model).toBe("f");
    expect(lines.join("\n")).toMatch(/semantic recall is on/);
  });

  it("a model that cannot load leaves keyword recall and says so once, with the reason", async () => {
    const lines: string[] = [];
    const s = startSemanticRecall({
      load: async () => {
        throw new Error("Cannot find package '@huggingface/transformers'");
      },
      log: (l) => lines.push(l),
    });
    expect(await s.settled).toMatchObject({ state: "off" });
    expect(s.current()).toBeUndefined();
    s.disable("again");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/keyword-only/);
    expect(lines[0]).toMatch(/@huggingface\/transformers/);
  });

  it("a probe that returns the wrong shape counts as not loaded", async () => {
    const broken: Embedder = { model: "b", modelVersion: "1", dimensions: 3, embed: async () => [[1, 0]] };
    const s = startSemanticRecall({ load: () => broken, log: () => {} });
    expect(await s.settled).toMatchObject({ state: "off" });
  });

  it("switched off by configuration, nothing loads", async () => {
    let loaded = false;
    const s = startSemanticRecall({ load: () => ((loaded = true), new FakeEmbedder("f", 2, vec)), disabledBy: "AL_BUDDY_MEMORY_SEMANTIC=off", log: () => {} });
    expect(await s.settled).toEqual({ state: "off", reason: "AL_BUDDY_MEMORY_SEMANTIC=off" });
    expect(loaded).toBe(false);
  });

  it("indexLimit 0 skips the backfill", async () => {
    const store = new InMemoryStore();
    await store.addNode(fact("x"));
    const s = startSemanticRecall({ load: () => new FakeEmbedder("f", 2, vec), indexStore: store, indexLimit: 0, log: () => {} });
    expect(await s.settled).toMatchObject({ state: "ready", indexed: 0 });
    expect(await store.listEmbeddings("f")).toHaveLength(0);
  });
});

describe("governanceTools with a late embedder", () => {
  it("recalls by keyword until the embedder is there, then by meaning", async () => {
    const store = new InMemoryStore();
    let embedder: Embedder | undefined;
    const t = governanceTools({ store, embedder: () => embedder });
    const saved = await t.remember({ text: "Moved to Tokyo" });
    expect(await t.recall({ query: "Japan" })).toEqual([]); // keyword: no shared word
    embedder = new FakeEmbedder("f", 2, vec);
    await indexMissingEmbeddings(store, embedder);
    expect((await t.recall({ query: "Japan" })).map((f) => f.id)).toEqual([saved.id]);
  });

  it("an embedder that throws mid-session falls back to keyword recall and reports it", async () => {
    const store = new InMemoryStore();
    const failures: string[] = [];
    const bad: Embedder = { model: "x", modelVersion: "1", dimensions: 2, embed: async () => { throw new Error("onnx crashed"); } };
    const t = governanceTools({ store, embedder: () => bad, onEmbedderFailure: (r) => failures.push(r) });
    const saved = await t.remember({ text: "Lives in Berlin" }); // the index fails; the fact is stored
    expect((await t.recall({ query: "Berlin" })).map((f) => f.id)).toEqual([saved.id]);
    expect(failures).toEqual(["onnx crashed", "onnx crashed"]);
  });

  it("hybrid recall reads time cues by default (expand) and not when expand is false", async () => {
    const store = new InMemoryStore();
    const e = new FakeEmbedder("f", 2, () => [1, 0]);
    const at = (iso: string) => () => new Date(iso);
    const old = await governanceTools({ store, embedder: e, now: at("2026-01-05T00:00:00Z") }).remember({ text: "Started the garden project" });
    const recent = await governanceTools({ store, embedder: e, now: at("2026-09-20T00:00:00Z") }).remember({ text: "Started the garden project again" });
    const ask = (expand: boolean, query: string) =>
      governanceTools({ store, embedder: e, expand, now: at("2026-10-01T00:00:00Z") }).recall({ query, limit: 2 }).then((r) => r[0]!.id);
    // With expand, a period the question names favours the facts that became true inside it —
    // a whole fused list, enough to outweigh any tie in the words.
    expect(await ask(true, "the garden project in January")).toBe(old.id);
    expect(await ask(true, "the garden project in September")).toBe(recent.id);
    // Without it, the month is just a word nothing contains: both questions rank alike.
    expect(await ask(false, "the garden project in January")).toBe(await ask(false, "the garden project in September"));
  });
});

describe("export — the portable format, as the policy lets it leave", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "abm-export-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("returns a small export inline, without what the assistant could not recall", async () => {
    const inner = new InMemoryStore();
    const t = governanceTools({ store: serverStore(inner), exportStore: serverExportView(inner) });
    await t.remember({ text: "Prefers tea" });
    await t.remember({ text: "the wifi password is hunter2" }); // stored Sensitive
    const out = await t.export({});
    expect("formatVersion" in out && out.projects[0]!.nodes.map((n) => n.content.text)).toEqual(["Prefers tea"]);
    expect(await inner.listNodes()).toHaveLength(2);
  });

  it("writes to a new absolute .json path only when the server allows files, and never overwrites", async () => {
    const inner = new InMemoryStore();
    const t = governanceTools({ store: serverStore(inner), exportStore: serverExportView(inner), exportToFiles: true });
    await t.remember({ text: "Prefers tea" });
    const path = join(dir, "memory.json");
    const written = await t.export({ path });
    expect(written).toMatchObject({ path, facts: 1, edges: 0 });
    expect(JSON.parse(readFileSync(path, "utf8")).projects[0].nodes[0].content.text).toBe("Prefers tea");
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
    await expect(t.export({ path })).rejects.toThrow(/already exists/);
    await expect(t.export({ path: "relative.json" })).rejects.toThrow(/absolute/);
    await expect(t.export({ path: join(dir, "memory.txt") })).rejects.toThrow(/\.json/);
    await expect(t.export({ path: join(dir, "missing", "m.json") })).rejects.toThrow(/folder/);
  });

  it("refuses to write files when the server does not allow it (the remote connector)", async () => {
    const t = governanceTools({ store: new InMemoryStore() });
    const path = join(dir, "x.json");
    await expect(t.export({ path })).rejects.toThrow(/does not write files/);
    expect(existsSync(path)).toBe(false);
  });

  it("an export too big to return inline asks for a path", async () => {
    const store = new InMemoryStore();
    const t = governanceTools({ store });
    const long = "x".repeat(3_900);
    for (let i = 0; i < Math.ceil(EXPORT_INLINE_MAX_BYTES / 3_900) + 1; i += 1) await t.remember({ text: `${i} ${long}` });
    await expect(t.export({})).rejects.toThrow(/Give a path/);
  });
});
