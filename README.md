# al-buddy-memory

**Portable, governed, model-agnostic memory for AI agents.**

A fact is never deleted, only invalidated. Raw text is the source of truth. Embeddings are a disposable, model-tagged cache. Everything exports to one documented format. The memory outlives whatever model, runtime or company produced it.

---

## Why this exists

Every agent-memory product on the market answers one question well: *what does the agent recall?* None of them answers the four questions that decide whether you can trust and keep that memory:

| Question | This library | Letta | Mem0 | Zep |
|---|---|---|---|---|
| **Where did this fact come from, and who asserted it?** | Provenance on every node and edge (`UserInput` / `AIInferred` / `GuardianAdded` / `SystemGenerated`) | Memory-file git history | Metadata field | Graph episodes |
| **When was it true, and what replaced it?** | Bi-temporal: `validFrom` / `validTo` plus append-only transaction anchors; a `validAt` query reconstructs any past state | Git history of files, not a fact model | No | Temporal graph (its real strength) |
| **Can I take it with me, losslessly, to another runtime?** | One versioned JSON export with a published schema and conformance tests | `.af` (agent state, framework-shaped, archival memory not yet included) | Cloud export | Cloud-only since 2025 |
| **Does it run with no vendor, no key, no server?** | SQLite on disk, on-device embeddings | Self-host possible; cloud is the product | Cloud is the product | Cloud only |

That fourth column is the wedge. Recall benchmarks (LOCOMO, LongMemEval, DMR) are saturated: Mem0 published the paper, Zep published the rebuttal, and every 2026 entrant re-runs the same tables. **No public benchmark scores a memory system on provenance, invalidation or portability.** This library is built for exactly that axis, so it can publish the first one.

## What is in the box

- `MemoryStore`: a storage-agnostic interface; `SqliteMemoryStore` and `InMemoryStore` ship, with a **conformance suite** any backend can run against itself.
- `ProjectMemory`: one brain scoped by project or person, each in its own SQLite file.
- `HybridRetriever`: lexical + semantic recall with decay-aware confidence; embeddings on-device via transformers.js (no API key).
- `exportPortable` / `importPortable`: the lossless interchange format, versioned, with a [JSON Schema](docs/portable-format.schema.json).
- `PinnedBlocks`: a size-capped tier of facts that belong in every prompt, editable by the agent itself (the good idea in Letta's memory blocks, on top of a governed store).
- `consolidate`: a sleep-time pass that reads recent raw memory and writes **new** derived facts with provenance edges back to their sources; the raw is never rewritten (the good idea in Letta's sleep-time agents, without the summarize-and-discard).
- `buildSourceProvenance` / `readSourceProvenance`, `renderMemoryBlock`, `exportMemoryMarkdown`, decay helpers.

Node ≥ 20. One runtime dependency (`better-sqlite3`); transformers.js is optional.

```ts
import { SqliteMemoryStore, ProjectMemory, PinnedBlocks, exportPortable } from "al-buddy-memory";

const store = new SqliteMemoryStore("./brain.db");
await store.addNode({ provenance: "UserInput", memoryType: "Lesson", content: { text: "Chris prefers decisions over options." }, /* …governance fields… */ });
const pins = new PinnedBlocks(store);
await pins.pin({ text: "Never present options without a recommendation.", label: "rule" });
const snapshot = await exportPortable(/* … */);   // → docs/portable-format.schema.json
```

Full contract: [docs/SPEC.md](docs/SPEC.md). Design record: [docs/DECISION-2026-07-07.md](docs/DECISION-2026-07-07.md).

---

## The business case

**Goal.** Notoriety first, then a $10M+ outcome, on the same path the three incumbents took, improved at the two places they left open.

**What the incumbents did (verified Sept 2026).**

| | Letta (ex-MemGPT) | Mem0 | Zep |
|---|---|---|---|
| Traction artifact | arXiv paper → 363-point HN post → Discord demo bot; 24.7k stars | YC S24; arXiv benchmark paper (LOCOMO); 65k stars, 14M downloads | arXiv paper beating MemGPT on DMR; Graphiti 30.8k stars |
| Money | $10M seed (Felicis, 2024), **pre-revenue, on traction** | $3.9M seed + **$24M Series A** (2025) citing 41k stars and API-call growth | $2.3M total; ~$1M ARR (third-party estimate) |
| Kept open | Core framework, `.af` format (Apache-2.0) | Core SDK, MCP server, integrations (Apache-2.0) | Only the engine (Graphiti); retired self-hosting in 2025 |
| Kept paid | Hosting: $20/mo + per-agent + per-compute-second | Hosting: $19 → $79 → $249/mo, metered on memory operations; enterprise SSO/audit/HIPAA/SLA | Cloud only: $125 / $375 / enterprise, credit-metered |

Three lessons. (1) None of them charge for the library; the money is hosting plus **governance features** (SSO, audit, retention, SLAs). (2) Both funded companies raised on GitHub traction, not revenue. (3) Each won its moment by publishing a benchmark on the thing it was best at, and naming the competitors it beat.

**The two open lanes, and why they are ours.**

1. **The referee lane.** There is no interchange spec for a *single fact with provenance*, no conformance suite, and no benchmark on provenance, invalidation or portability. Publishing all three makes this project the referee of the category instead of the fourth entrant racing Mem0's own paper. Our architecture already optimizes for that axis; nobody else's does.
2. **The governance-as-MCP lane.** 217 memory MCP servers exist; all of them hand the agent facts. None hand it *provenance and validity*. An MCP server that answers "who said this, since when, and what superseded it" is unclaimed.

**Where the $10M comes from.** Open core, exactly like the three above, with the paid layer being what enterprises pay for anyway: hosted governed memory with audit trails, retention policies, portability guarantees and SSO, priced per fact-operation like Mem0. The arithmetic that gets there: ~350 teams at $2.5k/mo, or ~4,000 small teams at the $19–79 tiers plus a handful of enterprise contracts. The precedent that gets there faster: Mem0 raised $24M at a valuation well past $10M on 41k stars before that revenue existed. Both paths run through the same first milestone, which is being the named authority on memory governance.

**The risk he named.** *"Other people are raising money off open source stuff you can just steal."* True, and the three above are the proof. The defences are the ones that worked for them: be first with the spec and the benchmark (authorship is public and dated), own the name and the conformance badge, ship faster than a fork can, and keep the hosted governance layer closed. A fork gets the code; it does not get the referee's chair.

---

## Open-source plan

**Where.** GitHub (this repo, made public), npm (`al-buddy-memory`), arXiv-style write-up hosted here (a benchmark note, not a paper), Hacker News (Show HN), the MCP registries (mcpservers.org, awesome-mcp-servers, Glama), and framework docs (LangChain / CrewAI / Vercel AI SDK integrations).

**How, in order.** Each step has one artifact and one number that says it worked.

| Week | Artifact | Proof it worked |
|---|---|---|
| 1 | The spec: `docs/SPEC.md` + `docs/portable-format.schema.json` + one worked example, public, versioned | Citable by URL |
| 2–3 | This library public, plus a **conformance CLI** that scores any memory export (Letta `.af`, Mem0, Zep) on provenance / invalidation / portability, with a published comparison table | The CLI runs clean on at least one competitor's export |
| 4 | **Show HN**: title states the mechanism, not the vision ("Show HN: a provenance benchmark for AI memory — Letta, Mem0 and Zep scored on portability, not recall"), with a live demo page where you paste an export and watch it score | Front page within four hours (~150+ points); if not, a second attempt, not a retreat |
| Month 2 | The **MCP governance server**: the first memory MCP server that returns provenance and validity with every fact; listed in the registries; a Claude Code plugin if the directory is open | Stars cross an order of magnitude within 30 days of listing |
| Month 3 | One framework partnership naming this as the recommended provenance layer | Partner traffic shows up as a referrer |

**Automation.** Everything below is scripted or scheduled; nothing depends on remembering.

- `.github/workflows/ci.yml`: typecheck, tests and build on Node 20, 22, 24, on every push and PR.
- Release: tag `vX.Y.Z` → `.github/workflows/release.yml` builds, tests, publishes to npm with provenance, and cuts a GitHub Release with notes.
- Sync from Al Buddy: `scripts/sync-memory-lib.sh` in the main repo mirrors the memory core into this repo and runs this repo's own gates. A change that breaks them is a breaking change, caught before it ships. Next step: Al Buddy consumes this package as a dependency, so the library is the source of truth and the mirror script retires.
- Publicity: the Show HN draft and the MCP-registry submission checklist live in `docs/publishing/`.

**What stays private.** The assistant itself: the Telegram brain, the console, the dispatched coders, the briefings, the money lane, the project registry. This repository holds only the memory contract and its reference implementation.

**License.** Apache-2.0, the same as Letta, Mem0 and Zep's open engine — maximum adoption for the library; the hosted governance layer is the paid product.

---

## The conformance score

Recall benchmarks are saturated. Nobody scores whether a memory system can say **who**
asserted a fact, **since when**, whether it is **still true**, and whether the fact
**survives leaving the vendor**. This does, on any export you paste in:

```sh
npx al-buddy-memory conformance my-export.json          # format auto-detected
npx al-buddy-memory conformance agent.af --format blocks     # block-style agent files
npx al-buddy-memory conformance memories.json --format records  # flat memory records
npx al-buddy-memory conformance --demo                  # a small governed store, for comparison
```

Seven dimensions, each 0–100% with the reason spelled out; a dimension the sample cannot
prove (no retired facts present, say) is reported as unproven and left out of the total
instead of counted as a failure. Scores on real exports, as of v0.2.0:

| Export | Provenance | Since when | Retire without erasing | Confidence | Relations | Portability | Grade |
|---|---|---|---|---|---|---|---|
| al-buddy-memory (demo store) | 100% | 100% | 100% | 100% | 100% | 100% | **A** |
| Letta — their published `memgpt_agent.af` example, scored with the `blocks` adapter | 0% | 0% | 0% (blocks rewritten in place) | 0% | 0% | 67% | **F** |
| Mem0 — a `get_all` response in their documented shape, scored with the `records` adapter | 0% | 100% | 50% (expiry only) | 0% | 0% | 67% | **D** |

The adapters are written against export *shapes*, not vendors, and map only what the shape
records. If a system starts recording provenance, its score goes up — that is the point.
Adapters live in `src/conformance/adapters.ts`; add one for your shape and open a PR.

## The governance MCP server

There are more than two hundred memory MCP servers. All of them hand the agent a fact.
This one hands it a fact **it can weigh**: every `recall` result carries `provenance`,
`validFrom`, `validTo`, `current`, `confidence`, and — for a superseded fact — the id of
what replaced it. `invalidate` closes a fact's validity and keeps the record; nothing is
ever deleted.

```json
{ "mcpServers": { "memory": { "command": "npx", "args": ["al-buddy-memory-mcp"],
    "env": { "AL_BUDDY_MEMORY_DB": "~/.al-buddy-memory/brain.db" } } } }
```

Tools: `remember`, `recall`, `invalidate`, `pin`, `unpin`, `pinned`. SQLite on disk, no
service, no key. The tool bodies are a plain function over a `MemoryStore`
(`governanceTools(...)`, exported), so they run against any backend and test without a
transport.

## Roadmap

- [x] The spec and the portable format, published and versioned (this repo)
- [x] `al-buddy-memory conformance <export>`: score any memory export on provenance, invalidation and portability, with adapters for block-style agent files and flat memory records (v0.2.0)
- [x] The governance MCP server: the first memory server that returns provenance and validity with every fact (v0.2.0)
- [ ] A comparison table across the incumbents, and a live paste-your-export demo
- [ ] Framework integrations (LangChain, CrewAI, Vercel AI SDK)

## Development

```sh
npm ci
npm run typecheck && npm test && npm run build
```

Tests: 128, including a behavioural conformance suite every backend runs against itself.
