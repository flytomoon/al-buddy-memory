import { describe, expect, it } from "vitest";
import { FakeEmbedder } from "./embedder.js";
import { HybridRetriever, indexMissingEmbeddings } from "./hybrid-retriever.js";
import { InMemoryStore } from "./in-memory-store.js";
import { makeNode } from "./memory-store-conformance.spec.js";
import { FakeReranker, LocalReranker, passageWindows, relevanceOfLogits, rerankTexts } from "./reranker.js";

/** Scores a passage by how many times it says the word the query ends with. */
const wordCount = () =>
  new FakeReranker("fake-count", (query, passage) => {
    const word = query.toLowerCase().split(/\W+/).filter(Boolean).at(-1)!;
    return passage.toLowerCase().split(/\W+/).filter((w) => w === word).length;
  });

describe("passageWindows — long memories in pieces a cross-encoder reads whole", () => {
  it("a text that fits is one window: itself", () => {
    expect(passageWindows("  I moved to Tokyo.  ")).toEqual(["I moved to Tokyo."]);
  });

  it("breaks between sentences, repeats one sentence across each break, and loses no text", () => {
    const sentences = Array.from({ length: 12 }, (_, i) => `Sentence number ${i} is here.`);
    const windows = passageWindows(sentences.join(" "), { maxChars: 100 });
    expect(windows.length).toBeGreaterThan(1);
    for (const w of windows) expect(w.length).toBeLessThanOrEqual(100);
    for (const s of sentences) expect(windows.some((w) => w.includes(s))).toBe(true);
    // Each window after the first starts with the sentence the one before ended on.
    for (let i = 1; i < windows.length; i += 1) {
      const last = windows[i - 1]!.match(/Sentence number \d+ is here\.$/)![0];
      expect(windows[i]!.startsWith(last)).toBe(true);
    }
  });

  it("cuts a sentence longer than a window between words, and stops at maxWindows", () => {
    const long = Array.from({ length: 300 }, (_, i) => `word${i}`).join(" ");
    const windows = passageWindows(long, { maxChars: 200 });
    for (const w of windows) expect(w.length).toBeLessThanOrEqual(200);
    expect(windows.join(" ").split(" ").slice(0, 20)).toEqual(long.split(" ").slice(0, 20));
    expect(passageWindows(long, { maxChars: 200, maxWindows: 2 })).toHaveLength(2);
  });

  it("refuses a window that could hold nothing (it would never move forward)", () => {
    expect(() => passageWindows("abc", { maxChars: 0 })).toThrow(/maxChars must be an integer >= 1/);
    expect(() => passageWindows("abc", { maxChars: 0.5 })).toThrow(/maxChars/);
    expect(() => passageWindows("abc", { maxWindows: 0 })).toThrow(/maxWindows/);
    expect(passageWindows("abcd efgh", { maxChars: 1 }).length).toBeGreaterThan(0);
  });
});

describe("rerankTexts", () => {
  it("scores each text by its best window and returns them best first", async () => {
    const texts = ["nothing here", `${"filler text. ".repeat(100)}bread bread bread.`, "bread once"];
    const order = await rerankTexts(wordCount(), "what did I bake? bread", texts, { maxChars: 200 });
    expect(order.map((o) => o.index)).toEqual([1, 2, 0]);
    expect(order[0]!.score).toBe(3);
  });

  it("keeps the incoming order when the cross-encoder cannot tell texts apart", async () => {
    const order = await rerankTexts(new FakeReranker("flat", () => 0), "q", ["a", "b", "c"]);
    expect(order.map((o) => o.index)).toEqual([0, 1, 2]);
  });

  it("a NaN score never wins, and a reranker that answers for the wrong number of passages is refused", async () => {
    const nan = new FakeReranker("nan", (_q, p) => (p === "b" ? NaN : 1));
    expect((await rerankTexts(nan, "q", ["a", "b"])).map((o) => o.index)).toEqual([0, 1]);
    const short = { model: "short", score: async () => [1] };
    await expect(rerankTexts(short, "q", ["a", "b"])).rejects.toThrow(/returned 1 scores for 2 passages/);
  });

  it("asks nothing of the model when there is nothing to rank", async () => {
    let calls = 0;
    const counting = { model: "counting", score: async () => (calls += 1, []) };
    expect(await rerankTexts(counting, "q", [])).toEqual([]);
    expect(calls).toBe(0);
  });
});

describe("relevanceOfLogits and LocalReranker", () => {
  it("one logit is the score; two are 'relevant' minus 'not'; more is refused", () => {
    expect(relevanceOfLogits([[2.5], [-1]])).toEqual([2.5, -1]);
    expect(relevanceOfLogits([[1, 3]])).toEqual([2]);
    expect(() => relevanceOfLogits([[1, 2, 3]], "m")).toThrow(/m: expected one or two logits/);
  });

  it("defaults to the MiniLM cross-encoder, loads nothing until asked, and checks its batch size", async () => {
    const r = new LocalReranker();
    expect(r.model).toBe("Xenova/ms-marco-MiniLM-L-6-v2");
    expect(r.dtype).toBe("fp32");
    expect(await r.score("q", [])).toEqual([]); // no passages: no model load
    expect(() => new LocalReranker({ batchSize: 0 })).toThrow(/batchSize/);
  });
});

describe("HybridRetriever with a reranker", () => {
  async function seeded() {
    const store = new InMemoryStore();
    // "bread" three times ranks first by keyword; the reranker prefers the one about sourdough.
    await store.addNode(makeNode({ content: { text: "bread bread bread, the word, over and over" } }));
    await store.addNode(makeNode({ content: { text: "I baked a sourdough bread on Sunday" } }));
    await store.addNode(makeNode({ content: { text: "bread crumbs for the ducks" } }));
    await store.addNode(makeNode({ content: { text: "a note about sourdough starters" } })); // no "bread": recall never finds it
    return store;
  }
  const bySourdough = () => new FakeReranker("fake-sourdough", (_q, p) => (p.includes("sourdough") ? 1 : 0));

  it("reorders what recall found, and never adds a memory recall did not find", async () => {
    const store = await seeded();
    const plain = await new HybridRetriever(store).recall("bread", { limit: 10 });
    expect(plain[0]!.content.text).toBe("bread bread bread, the word, over and over");
    const reranked = await new HybridRetriever(store, undefined, { reranker: bySourdough() }).recall("bread", { limit: 10 });
    expect(reranked[0]!.content.text).toBe("I baked a sourdough bread on Sunday");
    expect(reranked.map((n) => n.nodeId).sort()).toEqual(plain.map((n) => n.nodeId).sort());
    expect(reranked.map((n) => n.content.text)).not.toContain("a note about sourdough starters");
  });

  it("reads the question, not a rewrite of it, and `rerank: false` skips it for one recall", async () => {
    const store = await seeded();
    const queries: string[] = [];
    const spy = new FakeReranker("spy", (q, p) => (queries.push(q), p.includes("sourdough") ? 1 : 0));
    const retriever = new HybridRetriever(store, undefined, { reranker: spy });
    const skipped = await retriever.recall("bread", { limit: 10, rerank: false });
    expect(queries).toEqual([]);
    expect(skipped[0]!.content.text).toBe("bread bread bread, the word, over and over");
    await retriever.recall("What bread did I bake?", { limit: 10, expand: { now: "2023-05-30T00:00:00.000Z" } });
    expect(new Set(queries)).toEqual(new Set(["What bread did I bake?"]));
  });

  it("reads only the top `rerankDepth` candidates; the rest keep their fused order below them", async () => {
    const store = await seeded();
    const seen: string[] = [];
    const spy = new FakeReranker("spy", (_q, p) => (seen.push(p), p.includes("ducks") ? 1 : 0));
    const plain = await new HybridRetriever(store).recall("bread", { limit: 10 });
    const out = await new HybridRetriever(store, undefined, { reranker: spy, rerankDepth: 2 }).recall("bread", { limit: 10 });
    expect(seen).toHaveLength(2);
    expect(out.slice(2).map((n) => n.nodeId)).toEqual(plain.slice(2).map((n) => n.nodeId));
    expect(() => new HybridRetriever(store, undefined, { rerankDepth: 0 })).toThrow(/rerankDepth/);
  });

  it("a scoped recall never shows the reranker an out-of-scope memory", async () => {
    const store = new InMemoryStore();
    const embedder = new FakeEmbedder("fake", 2, (t) => (t.includes("bread") ? [1, 0] : [0, 1]));
    await store.addNode(makeNode({ content: { text: "bread, in scope" }, contextualMetadata: { tags: ["mine"] } }));
    await store.addNode(makeNode({ content: { text: "bread, someone else's" }, contextualMetadata: { tags: ["theirs"] } }));
    await store.addNode(makeNode({ content: { text: "bread, sealed" }, contextualMetadata: { tags: ["mine"] }, privacyClassification: "Sealed" }));
    await indexMissingEmbeddings(store, embedder);
    const seen: string[] = [];
    const spy = new FakeReranker("spy", (_q, p) => (seen.push(p), 0));
    const out = await new HybridRetriever(store, embedder, { reranker: spy }).recall("bread", { limit: 10, tags: ["mine"] });
    expect(out.map((n) => n.content.text)).toEqual(["bread, in scope"]);
    expect(seen).toEqual(["bread, in scope"]);
  });

  it("freshness still weighs in after reranking", async () => {
    const store = new InMemoryStore();
    const older = await store.addNode(makeNode({ content: { text: "bread note one" } }));
    await new Promise((r) => setTimeout(r, 5));
    const newer = await store.addNode(makeNode({ content: { text: "bread note two" } }));
    // The reranker prefers the older note, by a little.
    const r = new FakeReranker("prefers-one", (_q, p) => (p.includes("one") ? 1 : 0));
    const retriever = new HybridRetriever(store, undefined, { reranker: r });
    expect((await retriever.recall("bread", { limit: 2 }))[0]!.nodeId).toBe(older.nodeId);
    // The reranked order counts as the two lists it replaces, so a freshness of 1 does not overturn it; 3 does.
    expect((await retriever.recall("bread", { limit: 2, freshness: 1 }))[0]!.nodeId).toBe(older.nodeId);
    expect((await retriever.recall("bread", { limit: 2, freshness: 3 }))[0]!.nodeId).toBe(newer.nodeId);
  });
});
