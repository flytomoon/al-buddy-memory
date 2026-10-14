# al-buddy-memory for LangChain JS and LangGraph JS

Long-term memory for LangGraph: a `BaseStore` your graph or agent already knows
how to use, with every write governed and stamped with the agent that made it.
Tested against `@langchain/langgraph` 1.4 and `@langchain/core` 1.2.

## Quick start

```ts
import { StateGraph, MessagesAnnotation } from "@langchain/langgraph";
import { AlBuddyMemoryStore, openAgentMemory } from "al-buddy-memory/langchain";

const memory = openAgentMemory("./brain.db");           // governed and audited; memory.close() on shutdown
const store = new AlBuddyMemoryStore({ store: memory.store, agent: "planner" });
const graph = new StateGraph(MessagesAnnotation)
  .addNode("remember", async (_state, config) => {
    await config.store!.put(["users", "u1"], "contact", { text: "Prefers email over calls" });
    return {};
  })
  .addEdge("__start__", "remember")
  .addEdge("remember", "__end__")
  .compile({ store });                                   // same place as InMemoryStore / PostgresStore
```

Install: `npm install al-buddy-memory @langchain/langgraph @langchain/core`.

## Why a store

LangGraph splits memory in two. **Checkpointers** hold one thread's state; keep
whichever you use. **Stores** hold what should outlive a thread, and they are
what `compile({ store })` and the prebuilt agents take. `AlBuddyMemoryStore`
extends `BaseStore`, so `get`, `put`, `search` (namespace prefix, `filter`,
`query`, `limit`/`offset`), `delete` and `listNamespaces` all work as documented.

What changes underneath:

- A `put` is a governed fact; its text comes from `value.text` (or `content`,
  `memory`, `fact`, `note`), else the JSON of the value.
- Putting the same namespace + key again **replaces** it by invalidation: the
  old value is closed and linked to its successor, still in history.
- A `delete` invalidates; it does not erase. Erasure stays a deliberate,
  policy-judged `deleteNode` on the governed handle.

## Tools for agents

`alBuddyMemoryTools(opts)` returns `remember`, `recall`, `invalidate` and
`explain` as LangChain tools (JSON results) for any tool-calling agent. Writes
record `origin.via = "al-buddy-memory/langchain"`.

## Use a governed handle

`openAgentMemory(path)` returns `{ store, close }`. `store` applies the
personal-default policies, and every write is audited into the `audit_events`
table of the same file, in the same transaction as the fact. Check the trail with
`al-buddy-memory verify-audit ./brain.db` (it prints `intact: N events, head …`).
`close()` closes the file once your last call has finished. `{ audit: "none" }`
keeps no trail; `{ audit: sink }` sends events to an `AuditSink` of your own.

A raw `SqliteMemoryStore` works but skips the policies and keeps no trail — don't
hand one to an agent.
