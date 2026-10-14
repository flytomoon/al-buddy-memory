# al-buddy-memory for the Vercel AI SDK

Long-term memory for an AI SDK agent: facts that outlive the conversation, each
stamped with which agent wrote it, retired rather than deleted when they stop
being true, and explainable in one call. Tested against `ai` 7.

## Quick start

```ts
import { gateway, generateText, isStepCount, wrapLanguageModel } from "ai";
import { alBuddyMemoryMiddleware, alBuddyMemoryTools, openAgentMemory } from "al-buddy-memory/ai-sdk";

const { store, close } = openAgentMemory("./brain.db"); // governed and audited
const memory = { store, agent: "support-bot", app: "my-app" };
const { text } = await generateText({
  model: wrapLanguageModel({ model: gateway("anthropic/claude-sonnet-5"), middleware: alBuddyMemoryMiddleware(memory) }),
  tools: alBuddyMemoryTools(memory),                    // remember, recall, invalidate, explain
  stopWhen: isStepCount(5),
  prompt: "Dana prefers email over phone calls — remember that.",
});
close();                                                // on shutdown: releases the file
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

`openAgentMemory(path)` returns `{ store, close }`. `store` is behind the
personal-default policies (secrets become Sensitive and stay out of recall), and
every write is audited into the `audit_events` table of the same file, in the
same transaction as the fact. Check the trail with
`al-buddy-memory verify-audit ./brain.db` (it prints `intact: N events, head …`).
`close()` closes the file once your last call has finished. Pass
`{ audit: "none" }` to keep no trail, or `{ audit: sink }` to send events to an
`AuditSink` of your own instead.

You can pass your own `govern(...)` handle instead. A raw `SqliteMemoryStore`
also works, but it skips your policies and keeps no trail — don't hand one to an
agent.
