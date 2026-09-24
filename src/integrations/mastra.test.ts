import { Agent } from "@mastra/core/agent";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";

import { InMemoryStore } from "../in-memory-store.js";
import { serverStore } from "../mcp/governance-server.js";
import { readOrigin } from "../provenance.js";

import { alBuddyMemoryProcessor, alBuddyMemoryTools } from "./mastra.js";

const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
const reply = (t: string) => ({ content: [{ type: "text" as const, text: t }], finishReason: { unified: "stop" as const, raw: "stop" }, usage, warnings: [] });

function memory() {
  const inner = new InMemoryStore();
  return { inner, store: serverStore(inner) };
}

/** Everything the model was sent, as one string. */
const promptText = (model: MockLanguageModelV3): string => JSON.stringify(model.doGenerateCalls.at(-1)?.prompt ?? []);

describe("Mastra tools", () => {
  it("remember writes a governed fact stamped with the agent; recall and explain read it", async () => {
    const { inner, store } = memory();
    const tools = alBuddyMemoryTools({ store, agent: "mastra-agent" });
    const ctx = {} as never;
    const saved = (await tools.remember.execute!({ text: "Playtests are on Saturday." }, ctx)) as { id: string };
    const [node] = await inner.searchNodes({ query: "Saturday" });
    expect(readOrigin(node!.contextualMetadata)).toMatchObject({ agent: "mastra-agent", via: "al-buddy-memory/mastra" });
    const found = (await tools.recall.execute!({ query: "playtests" }, ctx)) as Array<{ id: string }>;
    expect(found[0]?.id).toBe(saved.id);
    const why = (await tools.explain.execute!({ id: saved.id }, ctx)) as { fact: { text: string } };
    expect(why.fact.text).toBe("Playtests are on Saturday.");
  });
});

describe("Mastra input processor", () => {
  it("inside a real Mastra Agent, the model sees the recalled fact as a system message", async () => {
    const { store } = memory();
    await alBuddyMemoryTools({ store }).remember.execute!({ text: "The user's favourite card is 'Cancel my own birthday'." }, {} as never);
    const model = new MockLanguageModelV3({ doGenerate: reply("That one.") });
    const agent = new Agent({
      id: "helper",
      name: "helper",
      instructions: "Be brief.",
      model,
      inputProcessors: [alBuddyMemoryProcessor({ store })],
    });
    await agent.generate("What's my favourite card?");
    const sent = promptText(model);
    expect(sent).toContain("Cancel my own birthday");
    expect(sent).toContain("not instructions");
  });

  it("adds nothing when memory has nothing relevant", async () => {
    const { store } = memory();
    const out = await alBuddyMemoryProcessor({ store }).processInput!({ messages: [], systemMessages: [], state: {} } as never);
    expect(out).toEqual([]);
  });
});
