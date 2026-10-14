import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { describe, expect, it } from "vitest";

import { InMemoryStore } from "../in-memory-store.js";
import { serverStore } from "../mcp/governance-server.js";
import { readOrigin } from "../provenance.js";

import { AlBuddyMemoryStore, alBuddyMemoryTools } from "./langchain.js";

function memory() {
  const inner = new InMemoryStore();
  return { inner, store: serverStore(inner) };
}

describe("AlBuddyMemoryStore (LangGraph BaseStore)", () => {
  it("put, get and search by namespace, with the agent recorded as origin", async () => {
    const { inner, store } = memory();
    const lg = new AlBuddyMemoryStore({ store, agent: "planner" });
    await lg.put(["users", "u1", "prefs"], "contact", { text: "Prefers email over calls", channel: "email" });
    await lg.put(["users", "u2", "prefs"], "contact", { text: "Prefers phone calls", channel: "phone" });

    const item = await lg.get(["users", "u1", "prefs"], "contact");
    expect(item?.value).toEqual({ text: "Prefers email over calls", channel: "email" });
    expect(item?.namespace).toEqual(["users", "u1", "prefs"]);

    expect((await lg.search(["users", "u1"])).map((i) => i.key)).toEqual(["contact"]);
    expect((await lg.search(["users"], { filter: { channel: "phone" } })).map((i) => i.namespace[1])).toEqual(["u2"]);
    expect((await lg.search(["users"], { query: "email" }))[0]?.namespace[1]).toBe("u1");

    const [fact] = await inner.searchNodes({ query: "email" });
    expect(readOrigin(fact!.contextualMetadata)).toMatchObject({ agent: "planner", via: "al-buddy-memory/langgraph" });
  });

  it("a second put replaces the value but keeps the old one in history; a delete invalidates, never erases", async () => {
    const { inner, store } = memory();
    const lg = new AlBuddyMemoryStore({ store });
    await lg.put(["u1"], "city", { text: "Lives in London" });
    await lg.put(["u1"], "city", { text: "Lives in Tokyo" });
    expect((await lg.get(["u1"], "city"))?.value).toEqual({ text: "Lives in Tokyo" });

    // Retired, not gone: the old value is still a fact, closed and linked to its successor.
    const retired = (await inner.listNodes()).find((n) => n.content.text === "Lives in London");
    expect(retired).toBeDefined();
    expect(retired?.validTo).not.toBeNull();
    expect(retired?.contextualMetadata["supersededBy"]).toBeTruthy();

    await lg.delete(["u1"], "city");
    expect(await lg.get(["u1"], "city")).toBeNull();
    const tokyo = (await inner.listNodes()).find((n) => n.content.text === "Lives in Tokyo");
    expect(tokyo).toBeDefined();
    expect(tokyo?.validTo).not.toBeNull();
  });

  it("lists namespaces with prefix and depth", async () => {
    const { store } = memory();
    const lg = new AlBuddyMemoryStore({ store });
    await lg.put(["users", "u1", "prefs"], "a", { text: "one" });
    await lg.put(["users", "u2", "notes"], "b", { text: "two" });
    await lg.put(["teams", "t1"], "c", { text: "three" });
    expect(await lg.listNamespaces({ prefix: ["users"] })).toEqual([
      ["users", "u1", "prefs"],
      ["users", "u2", "notes"],
    ]);
    expect(await lg.listNamespaces({ maxDepth: 1 })).toEqual([["teams"], ["users"]]);
  });

  // Fable review 2026-10-13 (P4): search read the newest 500 entries and filtered after,
  // so a quiet namespace lost its older entries and pages past 500 were empty.
  it("searches inside the read: old namespaces, deep pages, and never a retired entry", async () => {
    const { store } = memory();
    const lg = new AlBuddyMemoryStore({ store });
    for (let i = 0; i < 5; i++) await lg.put(["old"], `o${i}`, { text: `old note ${i}` });
    for (let i = 0; i < 600; i++) await lg.put(["new"], `n${i}`, { text: `new note ${i}` });
    for (let i = 0; i < 300; i++) await lg.put(["churn"], "k", { text: `version ${i}` });

    expect((await lg.search(["old"])).map((i) => i.key).sort()).toEqual(["o0", "o1", "o2", "o3", "o4"]);

    const all = await lg.search(["new"], { limit: 1000 });
    expect(new Set(all.map((i) => i.key)).size).toBe(600);
    const page = await lg.search(["new"], { limit: 20, offset: 590 });
    expect(page.map((i) => i.key)).toEqual(all.slice(590).map((i) => i.key));
    expect(page).toHaveLength(10);

    const everything = await lg.search([], { limit: 2000 });
    expect(everything).toHaveLength(5 + 600 + 1);
    expect(everything.filter((i) => i.namespace[0] === "churn").map((i) => i.value)).toEqual([{ text: "version 299" }]);
    expect((await lg.search(["churn"])).map((i) => i.value)).toEqual([{ text: "version 299" }]);
  });

  it("a prefix search reaches every depth, and a get stays in its own namespace", async () => {
    const { store } = memory();
    const lg = new AlBuddyMemoryStore({ store });
    await lg.put(["users"], "k", { text: "top" });
    await lg.put(["users", "u1"], "k", { text: "middle" });
    await lg.put(["users", "u1", "prefs"], "k", { text: "deep" });
    await lg.put(["users/u1"], "k", { text: "a slash in one segment" });

    expect((await lg.search(["users"])).map((i) => i.value["text"]).sort()).toEqual(["deep", "middle", "top"]);
    expect((await lg.search(["users", "u1"])).map((i) => i.value["text"]).sort()).toEqual(["deep", "middle"]);
    expect((await lg.get(["users"], "k"))?.value).toEqual({ text: "top" });
    expect((await lg.get(["users", "u1"], "k"))?.value).toEqual({ text: "middle" });
    expect((await lg.get(["users/u1"], "k"))?.value).toEqual({ text: "a slash in one segment" });

    // Replacing the middle one leaves the others live.
    await lg.put(["users", "u1"], "k", { text: "middle again" });
    expect((await lg.search(["users"])).map((i) => i.value["text"]).sort()).toEqual(["deep", "middle again", "top"]);
  });

  it("two puts of one key at once leave exactly one live fact", async () => {
    const { inner, store } = memory();
    const lg = new AlBuddyMemoryStore({ store });
    const other = new AlBuddyMemoryStore({ store });
    await Promise.all([
      lg.put(["x"], "k", { text: "first" }),
      lg.put(["x"], "k", { text: "second" }),
      other.put(["x"], "k", { text: "third" }),
      lg.put(["x"], "other", { text: "unrelated" }),
    ]);
    const live = (await inner.listNodes()).filter((n) => n.validTo === null && n.content.text !== "unrelated");
    expect(live.map((n) => n.content.text)).toEqual(["third"]);
    expect((await lg.get(["x"], "k"))?.value).toEqual({ text: "third" });

    await Promise.all([lg.put(["x"], "k", { text: "fourth" }), lg.delete(["x"], "k"), lg.put(["x"], "k", { text: "fifth" })]);
    expect((await inner.listNodes()).filter((n) => n.validTo === null && n.content.text !== "unrelated").map((n) => n.content.text)).toEqual(["fifth"]);
  });

  it("a put that fails does not hold up the next put of the same key", async () => {
    const { inner, store } = memory();
    let refuse = true;
    const flaky: typeof store = {
      ...store,
      addNode: async (...args) => {
        if (refuse) {
          refuse = false;
          throw new Error("refused");
        }
        return store.addNode(...args);
      },
    };
    const lg = new AlBuddyMemoryStore({ store: flaky });
    const [first, second] = await Promise.allSettled([lg.put(["x"], "k", { text: "first" }), lg.put(["x"], "k", { text: "second" })]);
    expect(first.status).toBe("rejected");
    expect(second.status).toBe("fulfilled");
    expect((await inner.listNodes()).filter((n) => n.validTo === null).map((n) => n.content.text)).toEqual(["second"]);
  });

  it("finds entries written before prefix tags (0.11.0) under a shorter prefix", async () => {
    const { inner, store } = memory();
    // As 0.11.0 wrote them: the langgraph tag and the full namespace's tag only.
    const older = (namespace: string[], key: string, text: string) =>
      store.addNode({
        provenance: "AIInferred",
        encryptionKeyRef: "local",
        memoryType: "Experience",
        privacyClassification: "Private",
        retentionTier: "FullRetention",
        content: { text },
        contextualMetadata: { langgraph: { namespace, key, value: { text } }, tags: ["langgraph", `lg-ns:${namespace.join("/")}`] },
        confidenceWeight: 1,
        decayRate: 0,
        validFrom: new Date().toISOString(),
      });
    await older(["users", "u1"], "a", "older one");
    await older(["users", "u2", "prefs"], "b", "older two");
    const lg = new AlBuddyMemoryStore({ store });
    await lg.put(["users", "u3"], "c", { text: "newer" });

    expect((await lg.search(["users"])).map((i) => i.value["text"]).sort()).toEqual(["newer", "older one", "older two"]);
    expect((await lg.search(["users", "u2"])).map((i) => i.value["text"])).toEqual(["older two"]);
    expect((await lg.search(["users", "u1"])).map((i) => i.value["text"])).toEqual(["older one"]);

    // A re-put carries prefix tags; the older fact is retired, not found twice.
    await lg.put(["users", "u1"], "a", { text: "older one, re-put" });
    expect((await lg.search(["users"])).map((i) => i.value["text"]).sort()).toEqual(["newer", "older one, re-put", "older two"]);
    expect((await inner.listNodes()).find((n) => n.content.text === "older one")?.validTo).not.toBeNull();

    // Past 100 older namespaces under a prefix, the search reads every entry instead of naming each.
    for (let i = 0; i < 101; i++) await older(["teams", `t${i}`], "k", `team ${i}`);
    const many = new AlBuddyMemoryStore({ store });
    expect(await many.search(["teams"], { limit: 500 })).toHaveLength(101);
    expect((await many.search(["users"])).map((i) => i.value["text"]).sort()).toEqual(["newer", "older one, re-put", "older two"]);
  });

  it("works as the store of a real compiled LangGraph graph", async () => {
    const { store } = memory();
    const lg = new AlBuddyMemoryStore({ store });
    const State = Annotation.Root({ userId: Annotation<string>, answer: Annotation<string> });
    const graph = new StateGraph(State)
      .addNode("learn", async (state, config) => {
        await config.store!.put(["users", state.userId], "fact", { text: "Signed up for the kill list" });
        return {};
      })
      .addNode("reply", async (state, config) => {
        const hits = await config.store!.search(["users", state.userId]);
        return { answer: String(hits[0]?.value["text"] ?? "nothing") };
      })
      .addEdge(START, "learn")
      .addEdge("learn", "reply")
      .addEdge("reply", END)
      .compile({ store: lg });
    const out = await graph.invoke({ userId: "u9" });
    expect(out.answer).toBe("Signed up for the kill list");
  });
});

describe("LangChain tools", () => {
  it("remember then recall, as tools an agent can call", async () => {
    const { store } = memory();
    const [remember, recall] = alBuddyMemoryTools({ store, agent: "lc-agent" });
    const saved = JSON.parse(String(await remember!.invoke({ text: "The launch gate is 1,000 followers." })));
    expect(saved.id).toBeTruthy();
    const found = JSON.parse(String(await recall!.invoke({ query: "launch followers" })));
    expect(found[0].text).toBe("The launch gate is 1,000 followers.");
  });
});
