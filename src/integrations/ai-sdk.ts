/**
 * Vercel AI SDK (`ai` ≥ 7). Two shapes, use either or both:
 *
 * - `alBuddyMemoryTools(opts)` — a ToolSet (remember, recall, invalidate,
 *   explain) for `generateText` / `streamText` / agents, so the model decides
 *   when to read and write memory.
 * - `alBuddyMemoryMiddleware(opts)` — a language-model middleware for
 *   `wrapLanguageModel`: before every call it recalls against the latest user
 *   message and prepends the pinned rules and the recalled facts as a system
 *   message, fenced as stored data.
 *
 * Every write goes through the store you pass (governed, audited) with this
 * agent recorded as its origin. `ai` is an optional peer dependency.
 */
import { tool, type LanguageModelMiddleware, type ToolSet } from "ai";

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

const FRAMEWORK = "ai-sdk";

/** The four memory tools as AI SDK tools. */
export function alBuddyMemoryTools(opts: MemoryIntegrationOptions): ToolSet {
  const mem = memoryToolkit(opts, FRAMEWORK);
  return {
    remember: tool({ description: TOOL_DESCRIPTIONS.remember, inputSchema: rememberInput, execute: async ({ text }) => mem.remember({ text }) }),
    recall: tool({ description: TOOL_DESCRIPTIONS.recall, inputSchema: recallInput, execute: async ({ query, limit }) => mem.recall({ query, limit }) }),
    invalidate: tool({
      description: TOOL_DESCRIPTIONS.invalidate,
      inputSchema: invalidateInput,
      execute: async ({ id, reason, replacedBy }) => mem.invalidate({ id, reason, replacedBy }),
    }),
    explain: tool({ description: TOOL_DESCRIPTIONS.explain, inputSchema: explainInput, execute: async ({ id }) => mem.explain({ id }) }),
  };
}

/** The text of the last user message in an AI SDK prompt. */
function lastUserText(prompt: ReadonlyArray<{ role: string; content: unknown }>): string {
  for (let i = prompt.length - 1; i >= 0; i--) {
    const m = prompt[i]!;
    if (m.role !== "user") continue;
    if (typeof m.content === "string") return m.content;
    if (Array.isArray(m.content)) {
      return m.content
        .filter((p): p is { type: "text"; text: string } => !!p && typeof p === "object" && (p as { type?: unknown }).type === "text")
        .map((p) => p.text)
        .join(" ");
    }
  }
  return "";
}

/** Middleware that puts relevant memory in front of every model call. */
export function alBuddyMemoryMiddleware(opts: MemoryIntegrationOptions): LanguageModelMiddleware {
  const mem = memoryToolkit(opts, FRAMEWORK);
  return {
    transformParams: async ({ params }) => {
      const block = await memoryContext(mem, lastUserText(params.prompt), opts.contextLimit ?? 8);
      if (!block) return params;
      return { ...params, prompt: [{ role: "system", content: block }, ...params.prompt] };
    },
  };
}
