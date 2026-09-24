import { generateText, isStepCount, wrapLanguageModel } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";

import { InMemoryStore } from "../in-memory-store.js";
import { serverStore } from "../mcp/governance-server.js";
import { readOrigin } from "../provenance.js";

import { alBuddyMemoryMiddleware, alBuddyMemoryTools } from "./ai-sdk.js";

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};
const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], finishReason: { unified: "stop" as const, raw: "stop" }, usage, warnings: [] });
const call = (toolName: string, input: unknown) => ({
  content: [{ type: "tool-call" as const, toolCallId: "c1", toolName, input: JSON.stringify(input) }],
  finishReason: { unified: "tool-calls" as const, raw: "tool_calls" },
  usage,
  warnings: [],
});

function memory() {
  const inner = new InMemoryStore();
  return { inner, store: serverStore(inner) };
}

describe("AI SDK tools", () => {
  it("a model's remember call writes a governed fact stamped with the agent, and recall finds it", async () => {
    const { inner, store } = memory();
    const model = new MockLanguageModelV4({ doGenerate: [call("remember", { text: "Dana prefers email over phone calls." }), text("Noted.")] });
    const result = await generateText({ model, tools: alBuddyMemoryTools({ store, agent: "support-bot", app: "demo" }), prompt: "Remember: Dana prefers email.", stopWhen: isStepCount(3) });
    expect(result.text).toBe("Noted.");
    const [fact] = await inner.searchNodes({ query: "email" });
    expect(fact?.content.text).toBe("Dana prefers email over phone calls.");
    expect(readOrigin(fact!.contextualMetadata)).toMatchObject({ agent: "support-bot", app: "demo", via: "al-buddy-memory/ai-sdk" });
    const recalled = await alBuddyMemoryTools({ store }).recall!.execute!({ query: "Dana email" }, { toolCallId: "r", messages: [] });
    expect((recalled as Array<{ text: string }>)[0]?.text).toContain("prefers email");
  });

  it("invalidate retires a fact without deleting it, and explain says why it is believed", async () => {
    const { inner, store } = memory();
    const tools = alBuddyMemoryTools({ store });
    const opts = { toolCallId: "x", messages: [] };
    const saved = (await tools.remember!.execute!({ text: "The launch is on October 20." }, opts)) as { id: string };
    const why = (await tools.explain!.execute!({ id: saved.id }, opts)) as { fact: { text: string } };
    expect(why.fact.text).toBe("The launch is on October 20.");
    await tools.invalidate!.execute!({ id: saved.id, reason: "moved to November" }, opts);
    const node = await inner.getNode(saved.id);
    expect(node?.validTo).not.toBeNull();
    expect(node?.contextualMetadata["invalidatedBecause"]).toBe("moved to November");
  });

  it("input limits are enforced before anything is written", async () => {
    const { store } = memory();
    const schema = alBuddyMemoryTools({ store }).remember!.inputSchema as unknown as { safeParse(v: unknown): { success: boolean } };
    expect(schema.safeParse({ text: "x".repeat(4_001) }).success).toBe(false);
  });
});

describe("AI SDK middleware", () => {
  it("puts the pinned rules and the facts recalled for this turn in front of the model, fenced as data", async () => {
    const { store } = memory();
    const tools = alBuddyMemoryTools({ store });
    await tools.remember!.execute!({ text: "The user's dog is called Biscuit." }, { toolCallId: "a", messages: [] });
    const model = new MockLanguageModelV4({ doGenerate: text("Biscuit!") });
    await generateText({ model: wrapLanguageModel({ model, middleware: alBuddyMemoryMiddleware({ store }) }), prompt: "What is my dog called?" });
    const prompt = model.doGenerateCalls[0]!.prompt;
    expect(prompt[0]?.role).toBe("system");
    const block = String((prompt[0] as { content: string }).content);
    expect(block).toMatch(/not instructions/);
    expect(block).toContain("Biscuit");
  });

  it("leaves the prompt untouched when memory has nothing to add", async () => {
    const { store } = memory();
    const model = new MockLanguageModelV4({ doGenerate: text("hi") });
    await generateText({ model: wrapLanguageModel({ model, middleware: alBuddyMemoryMiddleware({ store }) }), prompt: "hello" });
    expect(model.doGenerateCalls[0]!.prompt.map((m) => m.role)).toEqual(["user"]);
  });
});
