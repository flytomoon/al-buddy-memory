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
