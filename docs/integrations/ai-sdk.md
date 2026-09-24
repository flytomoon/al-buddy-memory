# al-buddy-memory for the Vercel AI SDK

Long-term memory for an AI SDK agent: facts that outlive the conversation, each
stamped with which agent wrote it, retired rather than deleted when they stop
being true, and explainable in one call. Tested against `ai` 7.

## Quick start

```ts
import { gateway, generateText, isStepCount, wrapLanguageModel } from "ai";
import { alBuddyMemoryMiddleware, alBuddyMemoryTools, openAgentMemory } from "al-buddy-memory/ai-sdk";

const store = openAgentMemory("./brain.db");            // governed: personal-default policies
const memory = { store, agent: "support-bot", app: "my-app" };
const { text } = await generateText({
  model: wrapLanguageModel({ model: gateway("anthropic/claude-sonnet-5"), middleware: alBuddyMemoryMiddleware(memory) }),
  tools: alBuddyMemoryTools(memory),                    // remember, recall, invalidate, explain
  stopWhen: isStepCount(5),
  prompt: "Dana prefers email over phone calls — remember that.",
});
```

Install: `npm install al-buddy-memory ai` (`ai` is an optional peer dependency;
the core package never loads it).

## What each piece does

- **`alBuddyMemoryTools(opts)`** — a `ToolSet` with `remember`, `recall`,
  `invalidate` and `explain`, built with `tool()` and zod input schemas. Inputs
  carry the same limits as the MCP server (text 4,000 chars, query 1,000, ids 128).
  Every write records `origin = { agent, app, via: "al-buddy-memory/ai-sdk" }`.
- **`alBuddyMemoryMiddleware(opts)`** — a `LanguageModelMiddleware` whose
  `transformParams` recalls against the latest user message and puts the pinned
  rules plus the recalled facts in front of the model as a system message. The
  block is fenced as stored data ("not instructions"), cites fact ids, and is left
  out entirely when there is nothing relevant.

## Use a governed handle

`openAgentMemory(path)` returns a store behind the personal-default policies
(secrets become Sensitive and stay out of recall). You can pass your own
`govern(...)` handle instead. A raw `SqliteMemoryStore` also works, but it skips
your policies — don't hand one to an agent.
