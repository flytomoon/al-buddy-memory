# al-buddy-memory for Mastra

Long-term memory for a Mastra agent: relevant facts in front of the model on
every turn, and tools to write and correct them — governed, stamped with the
agent that wrote them, never silently overwritten. Tested against `@mastra/core` 1.70.

## Quick start

```ts
import { Agent } from "@mastra/core/agent";
import { alBuddyMemoryProcessor, alBuddyMemoryTools, openAgentMemory } from "al-buddy-memory/mastra";

const memory = { store: openAgentMemory("./brain.db"), agent: "helper" };
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

`openAgentMemory(path)` applies the personal-default policies. A raw
`SqliteMemoryStore` works but skips them — don't hand one to an agent.
