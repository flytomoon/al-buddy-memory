import { describe, expect, it } from "vitest";
import { expandedQueries, HybridRetriever } from "./hybrid-retriever.js";
import { InMemoryStore } from "./in-memory-store.js";
import { makeNode } from "./memory-store-conformance.spec.js";
import { analyzeQuery } from "./query-cues.js";
import { FakeReranker } from "./reranker.js";

/** Tuesday 30 May 2023: the moment the questions below are asked. */
const NOW = "2023-05-30T23:45:00.000Z";
const tick = () => new Promise((r) => setTimeout(r, 5));

/**
 * Two memories with the same words, told at different times. Without `expand`
 * nothing but the order they were recorded in tells them apart — the second
 * recorded wins the tie — so any change of order is `expand`'s doing.
 */
async function sameWordsTwice(text: string, recordedFirst: string, recordedSecond: string) {
  const store = new InMemoryStore();
  const first = await store.addNode(makeNode({ content: { text }, validFrom: recordedFirst }));
  await tick();
  const second = await store.addNode(makeNode({ content: { text }, validFrom: recordedSecond }));
  return { store, first, second, retriever: new HybridRetriever(store) };
}

describe("recall with expand — time", () => {
  it("favours memories from the period the question names, and drops none from outside it", async () => {
    const { first: inside, second: outside, retriever } = await sameWordsTwice("I baked bread today", "2023-05-25T10:00:00.000Z", "2023-01-10T10:00:00.000Z");
    const q = "How many times did I bake bread in the past two weeks?";
    expect((await retriever.recall(q, { limit: 5 })).map((n) => n.nodeId)).toEqual([outside.nodeId, inside.nodeId]);
    expect((await retriever.recall(q, { limit: 5, expand: { now: NOW } })).map((n) => n.nodeId)).toEqual([inside.nodeId, outside.nodeId]);
  });

  it("a period still counts after a reranker has put the candidates in its own order", async () => {
    const { store, first: inside, second: outside } = await sameWordsTwice("I baked bread today", "2023-05-25T10:00:00.000Z", "2023-01-10T10:00:00.000Z");
    // A cross-encoder that cannot tell them apart keeps the fused order: outside first.
    const retriever = new HybridRetriever(store, undefined, { reranker: new FakeReranker("flat", () => 0) });
    const q = "How many times did I bake bread in the past two weeks?";
    expect((await retriever.recall(q, { limit: 5 })).map((n) => n.nodeId)).toEqual([outside.nodeId, inside.nodeId]);
    expect((await retriever.recall(q, { limit: 5, expand: { now: NOW } })).map((n) => n.nodeId)).toEqual([inside.nodeId, outside.nodeId]);
  });

  it("resolves 'last week' against `now`: asked today, May 2023 is not last week", async () => {
    const { first: may, second: january, retriever } = await sameWordsTwice("I baked bread", "2023-05-25T10:00:00.000Z", "2023-01-10T10:00:00.000Z");
    const q = "What bread did I bake last week?";
    expect((await retriever.recall(q, { limit: 5, expand: { now: NOW } }))[0]!.nodeId).toBe(may.nodeId);
    // `true` asks as of `validAt` — now — and neither memory is from the week before now.
    expect((await retriever.recall(q, { limit: 5, expand: true }))[0]!.nodeId).toBe(january.nodeId);
  });

  /**
   * Thirty memories, less relevant as `i` grows ("bikes" said fewer times).
   * Every one but the last is told at a time that follows its relevance; the
   * last and least relevant is the odd one out in time (`oddOneOut`).
   */
  async function thirtyAboutBikes(timeOf: (i: number) => string) {
    const store = new InMemoryStore();
    const ids: string[] = [];
    for (let i = 0; i < 30; i += 1) {
      const text = [...Array<string>(30 - i).fill("bikes"), ...Array<string>(i).fill("pad")].join(" ");
      ids.push((await store.addNode(makeNode({ content: { text }, validFrom: timeOf(i) }))).nodeId);
    }
    return { retriever: new HybridRetriever(store), oddOneOut: ids[29]! };
  }
  const place = async (retriever: HybridRetriever, q: string, id: string, expand?: { now: string }) =>
    (await retriever.recall(q, { limit: 30, ...(expand ? { expand } : {}) })).map((n) => n.nodeId).indexOf(id);

  it("'currently' moves the memory valid from the latest time up the ranking — a nudge, not a jump to the top", async () => {
    const { retriever, oddOneOut: newest } = await thirtyAboutBikes((i) => (i === 29 ? "2023-05-01T00:00:00.000Z" : new Date(Date.UTC(2022, 0, 29 - i)).toISOString()));
    const q = "How many bikes do I currently own?";
    expect(await place(retriever, q, newest)).toBe(29);
    const nudged = await place(retriever, q, newest, { now: NOW });
    expect(nudged).toBeLessThan(25);
    expect(nudged).toBeGreaterThan(5);
  });

  it("'initially' does the same for the memory valid from the earliest time", async () => {
    const { retriever, oddOneOut: oldest } = await thirtyAboutBikes((i) => (i === 29 ? "2021-01-01T00:00:00.000Z" : new Date(Date.UTC(2022, 0, 1 + i)).toISOString()));
    const q = "How many bikes did I initially own?";
    expect(await place(retriever, q, oldest)).toBe(29);
    const nudged = await place(retriever, q, oldest, { now: NOW });
    expect(nudged).toBeLessThan(25);
    expect(nudged).toBeGreaterThan(5);
  });
});

describe("recall with expand — counting across memories", () => {
  // Past a keyword search's sixteen-word reach: "gardening" is word 18, "pottery" word 21.
  const q = "How many hours in total did I spend on all of my different hobbies such as the gardening and the pottery?";

  async function hobbies() {
    const store = new InMemoryStore();
    // Only the first memory shares a word with the question's first sixteen.
    await store.addNode(makeNode({ content: { text: "I spend hours on hobbies" }, contextualMetadata: { tags: ["me"] } }));
    const gardening = await store.addNode(makeNode({ content: { text: "Gardening Saturday: planted tomatoes" }, contextualMetadata: { tags: ["me"] } }));
    const pottery = await store.addNode(makeNode({ content: { text: "Pottery class, wheel throwing" }, contextualMetadata: { tags: ["me"] } }));
    await store.addNode(makeNode({ content: { text: "Pottery wheel for sale" }, contextualMetadata: { tags: ["someone-else"] } }));
    return { store, gardening, pottery };
  }

  it("searches every thing the question names, however late in the question it names it", async () => {
    const { store, gardening, pottery } = await hobbies();
    const retriever = new HybridRetriever(store);
    const plain = (await retriever.recall(q, { limit: 10 })).map((n) => n.nodeId);
    expect(plain).not.toContain(pottery.nodeId);
    const expanded = (await retriever.recall(q, { limit: 10, expand: { now: NOW } })).map((n) => n.nodeId);
    expect(expanded).toEqual(expect.arrayContaining([gardening.nodeId, pottery.nodeId]));
  });

  it("the scope holds for every query expand adds", async () => {
    const { store } = await hobbies();
    const out = await new HybridRetriever(store).recall(q, { limit: 10, tags: ["me"], expand: { now: NOW } });
    expect(out.map((n) => n.content.text)).not.toContain("Pottery wheel for sale");
  });

  it("the queries: the question, without its time words, and each thing named — parts only when it counts, each once", () => {
    const counting = "How many hours of jogging and yoga did I do last week?";
    expect(expandedQueries(counting, analyzeQuery(counting, { now: NOW }))).toEqual([
      counting,
      "How many hours of jogging and yoga did I do?",
      "How many hours of jogging",
      "yoga did I do hours",
    ]);
    const notCounting = "Where did my wife and I go on holiday last week?";
    expect(expandedQueries(notCounting, analyzeQuery(notCounting, { now: NOW }))).toEqual([notCounting, "Where did my wife and I go on holiday?"]);
    const plain = "What is my favourite colour?";
    expect(expandedQueries(plain, analyzeQuery(plain, { now: NOW }))).toEqual([plain]);
    // Without its period this one asks nothing ("What did I do?"): no second query to match every "I".
    const vague = "What did I do last weekend?";
    expect(expandedQueries(vague, analyzeQuery(vague, { now: NOW }))).toEqual([vague]);
  });

  it("recall without expand is the recall it always was", async () => {
    const { store } = await hobbies();
    const retriever = new HybridRetriever(store);
    expect(await retriever.recall(q, { limit: 10, expand: false })).toEqual(await retriever.recall(q, { limit: 10 }));
  });
});
