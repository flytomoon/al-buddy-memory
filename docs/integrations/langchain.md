# al-buddy-memory for LangChain JS and LangGraph JS

Long-term memory for LangGraph: a `BaseStore` your graph or agent already knows
how to use, with every write governed and stamped with the agent that made it.
Tested against `@langchain/langgraph` 1.4 and `@langchain/core` 1.2.

## Quick start

```ts
import { StateGraph, MessagesAnnotation } from "@langchain/langgraph";
import { AlBuddyMemoryStore, openAgentMemory } from "al-buddy-memory/langchain";

const store = new AlBuddyMemoryStore({ store: openAgentMemory("./brain.db"), agent: "planner" });
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
- `search` reads the namespace prefix and current facts only, inside one store
  read with no cap, then pages that ranked list with `limit`/`offset`. Retired
  values never come back, however often a key was replaced.
- Two puts of the same namespace + key at once run one after the other, so
  they leave one live fact. That queue is per memory handle in one process;
  two processes writing the same key can still both write.

### Entries written by 0.11.0

After 0.11.0 each entry is also tagged with every namespace it sits inside
(`lg-in:users`, `lg-in:users/u1` for `["users", "u1", "prefs"]`), which is
what lets a prefix search be one filter. Entries written by 0.11.0 carry only
their own namespace's tag (`lg-ns:users/u1/prefs`). They are still found: on
its first prefix search an `AlBuddyMemoryStore` reads every current entry once
to learn which namespaces hold older ones, and its searches name those
namespaces too (past 100 of them under one prefix, a search reads every entry).
Putting an older entry again replaces it with a fact that carries the new tags.

## Tools for agents

`alBuddyMemoryTools(opts)` returns `remember`, `recall`, `invalidate` and
`explain` as LangChain tools (JSON results) for any tool-calling agent. Writes
record `origin.via = "al-buddy-memory/langchain"`.

## Use a governed handle

`openAgentMemory(path)` applies the personal-default policies. A raw
`SqliteMemoryStore` works but skips them — don't hand one to an agent.
