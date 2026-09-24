# Listing submissions — drafts, not submitted

Where each framework lists third-party integrations, what its process asks for,
and the exact text to paste. Nothing here has been submitted. All three need the
integrations published on npm first (they ship in 0.7.0), and each links to the
docs page in this folder.

Docs URLs used below:

- AI SDK: https://github.com/flytomoon/al-buddy-memory/blob/main/docs/integrations/ai-sdk.md
- LangChain: https://github.com/flytomoon/al-buddy-memory/blob/main/docs/integrations/langchain.md
- Mastra: https://github.com/flytomoon/al-buddy-memory/blob/main/docs/integrations/mastra.md

---

## 1. Vercel AI SDK — Tools Registry

**Where:** a pull request to [vercel/ai](https://github.com/vercel/ai) that adds one
entry to `content/tools-registry/registry.ts`, following
[`contributing/add-new-tool-to-registry.md`](https://github.com/vercel/ai/blob/main/contributing/add-new-tool-to-registry.md).
The registry is shown at https://ai-sdk.dev/resources/tools.

**Their prerequisites:** published on npm; tested with the current AI SDK; docs on
your own site that point at the AI SDK guide specifically (`docsUrl`); a complete,
working `codeExample` using current patterns. Branch name they suggest:
`feat/add-tool-al-buddy-memory`.

**Entry:**

```ts
  {
    slug: 'al-buddy-memory',
    name: 'al-buddy-memory',
    description:
      'Long-term memory tools that run locally on SQLite with no API key: remember, recall, invalidate and explain. Every fact records which agent wrote it, facts that stop being true are retired rather than deleted, and a middleware puts relevant facts in front of the model each turn.',
    packageName: 'al-buddy-memory',
    tags: ['memory', 'local', 'sqlite'],
    installCommand: {
      pnpm: 'pnpm add al-buddy-memory',
      npm: 'npm install al-buddy-memory',
      yarn: 'yarn add al-buddy-memory',
      bun: 'bun add al-buddy-memory',
    },
    codeExample: `import { generateText, isStepCount } from 'ai';
import { alBuddyMemoryTools, openAgentMemory } from 'al-buddy-memory/ai-sdk';

const store = openAgentMemory('./brain.db');

const { text } = await generateText({
  model: 'anthropic/claude-sonnet-5',
  prompt: 'Remember that Dana prefers email over phone calls.',
  tools: alBuddyMemoryTools({ store, agent: 'support-bot' }),
  stopWhen: isStepCount(3),
});

console.log(text);`,
    docsUrl: 'https://github.com/flytomoon/al-buddy-memory/blob/main/docs/integrations/ai-sdk.md',
    websiteUrl: 'https://github.com/flytomoon/al-buddy-memory',
    npmUrl: 'https://www.npmjs.com/package/al-buddy-memory',
  },
```

**PR title:** `feat(tools-registry): add al-buddy-memory`

---

## 2. LangChain JS — Integration listing issue (Stores)

**Where:** LangChain does not take integration PRs to `langchainjs`. File an
**Integration listing** issue in [langchain-ai/docs](https://github.com/langchain-ai/docs/issues/new?template=06-integration-submission.yml)
(process: [`src/oss/contributing/publish-langchain.mdx`](https://github.com/langchain-ai/docs/blob/main/src/oss/contributing/publish-langchain.mdx)).
A maintainer labels it `integration-run`; automation opens the listing PR. Do not
open a manual docs PR. The row lands on the JS
[Store integrations](https://docs.langchain.com/oss/javascript/integrations/stores) page
next to InMemoryStore, Postgres, Redis and MongoDB.

**Form fields:**

| Field | Value |
|---|---|
| Display or class name | `AlBuddyMemoryStore` |
| Language | TypeScript |
| Component type | stores |
| PyPI package name | *(leave empty)* |
| npm package name | `al-buddy-memory` |
| Docs URL | https://github.com/flytomoon/al-buddy-memory/blob/main/docs/integrations/langchain.md |
| Source repository | https://github.com/flytomoon/al-buddy-memory |

**Short provider description:**

> A LangGraph `BaseStore` for long-term memory on a local SQLite file, no API key.
> Every put records which agent wrote it; putting a key again retires the old
> value instead of overwriting it, and a delete closes a fact rather than erasing
> it, so the history of what was believed is kept. Import from
> `al-buddy-memory/langchain`; also ships remember / recall / invalidate / explain
> as LangChain tools.

**Capability flags:** `search: true`, `filter: true`, `list_namespaces: true`, `ttl: false`

---

## 3. Mastra — feature request, then an integrations docs page

**Where:** Mastra's docs list integrations under
[`docs/src/content/en/integrations/`](https://github.com/mastra-ai/mastra/tree/main/docs/src/content/en/integrations)
(sidebar in `integrations/sidebars.js`, page rules in
[`docs/styleguides/GUIDE_INTEGRATION.md`](https://github.com/mastra-ai/mastra/blob/main/docs/styleguides/GUIDE_INTEGRATION.md)).
Their [CONTRIBUTING.md](https://github.com/mastra-ai/mastra/blob/main/CONTRIBUTING.md)
requires a **feature request issue first**; a PR is only accepted once the issue
has lost its `status: needs triage` / `needs approval` labels, and the PR must
link it (`Closes #…`). So: step 1 is the issue below; step 2, after approval, is
a PR adding `integrations/tools/al-buddy-memory.mdx` plus a sidebar entry under
the Tools category.

**Issue title:** `[Docs] List al-buddy-memory (long-term memory input processor + tools) under Integrations`

**Issue body:**

> **What:** a community integration page for
> [al-buddy-memory](https://github.com/flytomoon/al-buddy-memory), which adds
> long-term memory to a Mastra agent through the extension points Mastra already
> has — an input processor and `createTool` tools — without replacing `Memory`.
>
> - `alBuddyMemoryProcessor()` goes in `inputProcessors`. Before each turn it
>   recalls against the latest user message and appends relevant facts as a system
>   message, marked as stored data rather than instructions. Nothing is added when
>   nothing is relevant.
> - `alBuddyMemoryTools()` gives the agent remember / recall / invalidate /
>   explain. Every write records which agent made it; facts that stop being true
>   are retired, not deleted.
>
> Runs locally on SQLite with no API key. Tested against `@mastra/core` 1.70 with
> a real `Agent`. `Memory` keeps doing thread history alongside it.
>
> **Proposed change:** one page at `docs/src/content/en/integrations/tools/al-buddy-memory.mdx`
> following GUIDE_INTEGRATION.md, and one entry in `integrations/sidebars.js`.
> Happy to write it once approved.
>
> Docs: https://github.com/flytomoon/al-buddy-memory/blob/main/docs/integrations/mastra.md

**Page frontmatter for the later PR** (per their styleguide pattern `$PRODUCT | $CATEGORY`):

```mdx
---
title: 'al-buddy-memory | Tools'
description: 'Use al-buddy-memory with Mastra to give agents governed long-term memory that runs locally.'
---

# al-buddy-memory
```
