/**
 * Mastra (`@mastra/core` ≥ 1).
 *
 * Mastra's own `Memory` class is conversation storage — threads and messages —
 * and its recall features (semantic recall, working memory) run as INPUT
 * PROCESSORS that add context before the model is called. Long-term facts fit
 * that second extension point, not the first, so this ships:
 *
 * - `alBuddyMemoryProcessor(opts)` — an input processor (`inputProcessors` on
 *   an Agent) that recalls against the latest user message and adds the pinned
 *   rules and the recalled facts as a system message, fenced as stored data.
 *   Use it next to Mastra's Memory, which keeps the thread history.
 * - `alBuddyMemoryTools(opts)` — remember / recall / invalidate / explain as
 *   Mastra tools (`createTool`), so the agent can write and correct memory.
 */
import type { InputProcessor, ProcessInputArgs, ProcessInputResult } from "@mastra/core/processors";
import { createTool } from "@mastra/core/tools";

import {
  explainInput,
  invalidateInput,
  memoryContext,
  memoryToolkit,
  recallInput,
  rememberInput,
  TOOL_DESCRIPTIONS,
  type MemoryIntegrationOptions,
} from "./shared.js";

export { openAgentMemory, type MemoryIntegrationOptions } from "./shared.js";

const FRAMEWORK = "mastra";

/** The four memory tools as Mastra tools. */
export function alBuddyMemoryTools(opts: MemoryIntegrationOptions) {
  const mem = memoryToolkit(opts, FRAMEWORK);
  return {
    remember: createTool({ id: "remember", description: TOOL_DESCRIPTIONS.remember, inputSchema: rememberInput, execute: async ({ text }) => mem.remember({ text }) }),
    recall: createTool({ id: "recall", description: TOOL_DESCRIPTIONS.recall, inputSchema: recallInput, execute: async ({ query, limit }) => mem.recall({ query, limit }) }),
    invalidate: createTool({
      id: "invalidate",
      description: TOOL_DESCRIPTIONS.invalidate,
      inputSchema: invalidateInput,
      execute: async ({ id, reason, replacedBy }) => mem.invalidate({ id, reason, replacedBy }),
    }),
    explain: createTool({ id: "explain", description: TOOL_DESCRIPTIONS.explain, inputSchema: explainInput, execute: async ({ id }) => mem.explain({ id }) }),
  };
}

/** The text of the latest user message Mastra hands a processor. */
function lastUserText(messages: ProcessInputArgs["messages"]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== "user") continue;
    const parts = m.content.parts ?? [];
    const text = parts
      .filter((p): p is { type: "text"; text: string } => (p as { type?: unknown }).type === "text" && typeof (p as { text?: unknown }).text === "string")
      .map((p) => p.text)
      .join(" ");
    return text || (typeof m.content.content === "string" ? m.content.content : "");
  }
  return "";
}

/** An input processor that puts relevant long-term memory in front of the model. */
export function alBuddyMemoryProcessor(opts: MemoryIntegrationOptions): InputProcessor {
  const mem = memoryToolkit(opts, FRAMEWORK);
  return {
    id: "al-buddy-memory",
    name: "al-buddy-memory",
    description: "Adds the pinned rules and the facts recalled for this turn from al-buddy-memory.",
    async processInput({ messages, systemMessages }: ProcessInputArgs): Promise<ProcessInputResult> {
      const block = await memoryContext(mem, lastUserText(messages), opts.contextLimit ?? 8);
      if (!block) return messages;
      return { messages, systemMessages: [...systemMessages, { role: "system", content: block }] };
    },
  };
}
