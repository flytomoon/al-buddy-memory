# al-buddy-memory

> **Al Buddy** — that's *Al*, a name, said like "pal". Not A.I.


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

Recall benchmarks (LOCOMO, LongMemEval, DMR) measure what an agent remembers. **None of them scores a memory system on provenance, invalidation or portability.** This library is built for that axis, and the conformance scorer below is one attempt at measuring it. The table is our reading of each project's public docs as of September 2026; if we have a cell wrong, a PR with a link fixes it.

## Start here

An empty memory gives an assistant nothing to stand on. [docs/STARTER.md](docs/STARTER.md) seeds
yours in ten minutes: pin who the person is and how they want to be treated (including "never a
yes-person"), choose the rules the store enforces, and let it derive the rest nightly.

Upgrading from an earlier version: [CHANGELOG.md](CHANGELOG.md) marks anything that changes what
an existing caller gets back. 0.3.4 changes the order of tied reads — newest first now, oldest
before — so read that entry before you rely on a page.

## What is in the box

- `MemoryStore`: a storage-agnostic interface; `SqliteMemoryStore` and `InMemoryStore` ship, with a **conformance suite** any backend can run against itself.
- `ProjectMemory`: one brain scoped by project or person, each in its own SQLite file.
- `HybridRetriever`: lexical + semantic recall with decay-aware confidence; embeddings on-device via transformers.js (no API key). Recall can be scoped (memory type, tags, minimum confidence, privacy and retention tiers), and the scope applies to the keyword and the vector side alike.
- `exportPortable` / `importPortable`: the lossless interchange format, versioned, with a [JSON Schema](docs/portable-format.schema.json).
- `PinnedBlocks`: a size-capped tier of facts that belong in every prompt, editable by the agent itself, on top of the governed store.
- `consolidate`: a sleep-time pass that reads recent raw memory and writes **new** derived facts with provenance edges back to their sources; the raw is never rewritten and nothing is summarised away.
- `listConsolidations` / `undoConsolidation`: review what each pass concluded, with the evidence for every fact, and take back one pass's conclusions. Undo retracts (`validTo`) and records who withdrew each fact and why; it never deletes, so the history still shows what was believed, when it was withdrawn, and the reason.
- `buildSourceProvenance` / `readSourceProvenance`, `renderMemoryBlock`, `exportMemoryMarkdown`, decay helpers.

Node ≥ 20. One runtime dependency (`better-sqlite3`); transformers.js is optional.

Prior art: the Letta project published the idea of a pinned memory tier and a background pass over memory (memory blocks; sleep-time agents). What is different here: every derived fact must cite the raw it rests on or it is refused, the raw is never rewritten, and a whole pass can be reviewed and undone, with the undo and its reason kept on record.

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

## Python, and other languages

The MCP server and the portable format are the language-neutral surface: a Python agent can
use the governance server today, and any language can read the export (it is plain JSON with
a [schema](docs/portable-format.schema.json)). A native Python package is planned; open an
issue if you need it sooner and say what you would use first.

## License

Apache-2.0. See [LICENSE](LICENSE).

## Governance is enforced, not implied

The vocabulary — Public / Private / Sensitive / Sealed, retention tiers, provenance on
every fact and relation — ships with the store. `govern()` is what enforces it: policies
in front of every write, update, read and export, and an append-only audit trail of who
read what and why.

```ts
import { SqliteMemoryStore, govern, personalDefaults, JsonlAudit } from "al-buddy-memory";

const store = govern(new SqliteMemoryStore("brain.db"), {
  policies: [personalDefaults({ owner: "chris" })],
  context: () => ({ actor: currentActor() }),
  audit: new JsonlAudit("audit.jsonl"),
});
```

Three policies ship to copy: personal defaults (secrets auto-classified Sensitive and
never exported by anyone but the owner), guardian mode (only a guardian may write or
change a guardian's fact), enterprise audit (low-confidence inferences hidden from
non-reviewers; exports gated to exporters). A policy is a plain object with four
optional hooks; see [docs/GOVERNANCE.md](docs/GOVERNANCE.md).

Without any policy the store still guarantees: Sealed facts never surface unless asked
for by classification; `provenance`, `nodeId`, `encryptionKeyRef` and the anchor trail
are immutable after write; nothing is deleted.

The rules an assistant on this memory is held to are published in [docs/policies](docs/policies/README.md):
ethical behaviour, user sovereignty and privacy, lifecycle and guardians, data stewardship — and
[an honest ledger](docs/policies/ENFORCEMENT.md) of what the code enforces, what a prompt carries, and
what is still a person's decision. They change in the open.

## Limits, measured

One SQLite file, one process, one writer. Measured on an M1 Pro laptop with 100,000
facts (`bench/bench.mjs`, better-sqlite3, WAL):

| Operation (100,000 facts) | Measured |
|---|---|
| Insert, one fact per call | 5,400 facts/s (18.6 s for all 100k) |
| Keyword recall, top 10 (FTS5 + decay re-rank) | 25 ms median, 74 ms worst of five terms; first query after open ~360 ms (cold cache) |
| Recall by filters only, top 10 | 8 ms |
| Get by id | 0.2 ms |
| Invalidate a fact | 0.3 ms |
| File size | 62 MB |

What that means: a personal assistant or a single-tenant service will not notice the
store; a multi-tenant SaaS needs the Postgres backend on the roadmap. Node/TypeScript
only for now; the optional on-device embedder is a 25 MB model download.

## The conformance score

**Try it: [albuddy.com](https://albuddy.com/)** — paste any memory export, nothing leaves your browser.

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
instead of counted as a failure. The reference score:

| Export | Provenance | Since when | Retire without erasing | Confidence | Relations | Portability | Grade |
|---|---|---|---|---|---|---|---|
| al-buddy-memory (demo store) | 100% | 100% | 100% | 100% | 100% | 100% | **A** |

Score your own export the same way: `--format blocks` for block-style agent files, `--format records` for flat memory records, or paste it into the demo at [albuddy.com](https://albuddy.com). The scorer reports what the export records, nothing more.

The rulebook, including what the score does **not** measure (recall quality, truth, latency),
is [docs/SCORING.md](docs/SCORING.md). The adapters are written against export *shapes*, not vendors, and map only what the shape
records. If a system starts recording provenance, its score goes up — that is the point.
Adapters live in `src/conformance/adapters.ts`; add one for your shape and open a PR.

## The governance MCP server

Most memory MCP servers hand the agent a fact.
This one hands it a fact **it can weigh**: every `recall` result carries `provenance`,
`validFrom`, `validTo`, `current`, `confidence`, and — for a superseded fact — the id of
what replaced it. `invalidate` closes a fact's validity and keeps the record; nothing is
ever deleted.

```json
{ "mcpServers": { "memory": { "command": "npx", "args": ["al-buddy-memory-mcp"],
    "env": { "AL_BUDDY_MEMORY_DB": "~/.al-buddy-memory/brain.db" } } } }
```

A `recall` result looks like this — every field an agent needs to decide how much to trust the fact:

```json
{ "id": "…", "text": "Lives in Tokyo", "provenance": "UserInput", "validFrom": "2026-06-01T00:00:00Z",
  "validTo": null, "current": true, "confidence": 1, "supersededBy": null, "derivedFrom": [] }
```

Tools: `remember`, `recall`, `invalidate`, `pin`, `unpin`, `pinned`. SQLite on disk, no
service, no key. The tool bodies are a plain function over a `MemoryStore`
(`governanceTools(...)`, exported), so they run against any backend and test without a
transport.

## Roadmap

- [x] The spec and the portable format, published and versioned (this repo)
- [x] `al-buddy-memory conformance <export>`: score any memory export on provenance, invalidation and portability, with adapters for block-style agent files and flat memory records (v0.2.0)
- [x] The governance MCP server: a memory server that returns provenance and validity with every fact (v0.2.0)
- [x] Governance hooks with an audit trail and three sample policies; provenance immutable at runtime; measured limits at 100k facts (v0.3.0)
- [x] A comparison table and a live paste-your-export demo (albuddy.com)
- [ ] A Postgres backend behind the same `MemoryStore` interface, for multi-tenant and hosted deployments (SQLite stays the local-first default; the interface is small and the conformance suite is what a backend must pass)
- [ ] Framework integrations (LangChain, CrewAI, Vercel AI SDK)

## Development

```sh
npm ci
npm run check   # typecheck, tests, and the browser bundle — exactly what CI runs
```

Tests: 155, including a behavioural conformance suite every backend runs against itself.
