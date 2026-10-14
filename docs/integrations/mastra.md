# al-buddy-memory for Mastra

Long-term memory for a Mastra agent: relevant facts in front of the model on
every turn, and tools to write and correct them — governed, stamped with the
agent that wrote them, never silently overwritten. Tested against `@mastra/core` 1.70.

## Quick start

```ts
import { Agent } from "@mastra/core/agent";
import { alBuddyMemoryProcessor, alBuddyMemoryTools, openAgentMemory } from "al-buddy-memory/mastra";

const { store } = openAgentMemory("./brain.db");        // governed and audited
const memory = { store, agent: "helper" };
export const helper = new Agent({
  id: "helper",
  name: "helper",
  instructions: "You are a helpful assistant.",
  model: "anthropic/claude-sonnet-5",
  inputProcessors: [alBuddyMemoryProcessor(memory)],   // recall before each turn
  tools: alBuddyMemoryTools(memory),                    // remember, recall, invalidate, explain
});
```

Install: `npm install al-buddy-memory @mastra/core`.

## Why a processor, not a Memory class

Mastra's `Memory` is conversation storage — threads and messages — and its own
recall features (semantic recall, working memory) run as **input processors**
that add context before the model is called. Long-term facts belong at that
second extension point, so:

- **`alBuddyMemoryProcessor(opts)`** recalls against the latest user message
  and appends the pinned rules and recalled facts as a system message, fenced as
  stored data ("not instructions"), with fact ids. Nothing is added when nothing
  is relevant. Keep Mastra's `Memory` for thread history alongside it.
- **`alBuddyMemoryTools(opts)`** gives the agent `remember`, `recall`,
  `invalidate` and `explain` via `createTool`. Writes record
  `origin = { agent, app, via: "al-buddy-memory/mastra" }`.

## Use a governed handle

`openAgentMemory(path)` returns `{ store, close }`. `store` applies the
personal-default policies, and every write is audited into the `audit_events`
table of the same file, in the same transaction as the fact. Check the trail with
`al-buddy-memory verify-audit ./brain.db` (it prints `intact: N events, head …`).
`close()` closes the file once your last call has finished — on shutdown, for a
long-lived agent. `{ audit: "none" }` keeps no trail; `{ audit: sink }` sends
events to an `AuditSink` of your own.

A raw `SqliteMemoryStore` works but skips the policies and keeps no trail — don't
hand one to an agent.
