# al-buddy-memory

> **Al Buddy** — that's *Al*, a name, said like "pal". Not A.I.


**Portable, governed, model-agnostic memory for AI agents.**

A fact is invalidated, never overwritten; on a governed handle, erasure runs through policy and is audited. Raw text is the source of truth and cannot be edited. Embeddings are a disposable, model-tagged cache. Every fact and every link exports to one documented format. The memory outlives whatever model, runtime or company produced it.

---

## Why this exists

Every agent-memory product on the market answers one question well: *what does the agent recall?* None of them answers the four questions that decide whether you can trust and keep that memory:

| Question | This library | Letta | Mem0 | Zep |
|---|---|---|---|---|
| **Where did this fact come from, and who asserted it?** | Provenance on every node and edge (`UserInput` / `AIInferred` / `GuardianAdded` / `SystemGenerated`) | Memory-file git history | Metadata field | Graph episodes |
| **When was it true, and what replaced it?** | `validFrom` / `validTo` (valid time) plus append-only anchors (when the store touched a fact); a `validAt` query answers "what was true at X". It does not yet answer "what did we believe at X": an update records that a change happened, not the prior value | Git history of files, not a fact model | Change history per memory (`history()`: old value, new value, event, timestamps) — transaction history, not valid time | Temporal graph (its real strength): Graphiti edges carry `valid_at` / `invalid_at` alongside `created_at` / `expired_at` |
| **Can I take it with me, losslessly, to another runtime?** | One versioned JSON export with a published schema and conformance tests | `.af` (agent state, framework-shaped, archival memory not yet included) | Cloud export | Cloud-only since 2025 |
| **Does it run with no vendor, no key, no server?** | SQLite on disk, on-device embeddings | Self-host possible; cloud is the product | Self-host possible (Apache-2.0, local vector stores); needs an LLM for extraction; cloud is the product | Zep is cloud; Graphiti self-hosts (graph DB + LLM key required) |

Sources for the cells above, each checked against the project's own code or announcement on 2026-09-18: Mem0's per-memory history is a SQLite table with `old_memory`, `new_memory`, `event`, `created_at`, `updated_at` ([`mem0/memory/storage.py`](https://github.com/mem0ai/mem0/blob/main/mem0/memory/storage.py)); Mem0 is Apache-2.0 and runs against local vector stores including Qdrant, Chroma, pgvector and FAISS ([vector-store docs](https://docs.mem0.ai/components/vectordbs/overview)), with an LLM called to extract facts on the default `add()` path. Zep stopped maintaining Community Edition on 2025-04-02, in [its own words](https://blog.getzep.com/announcing-a-new-direction-for-zeps-open-source-strategy/): *"we've decided to stop maintaining and releasing Zep Community Edition."* [Graphiti](https://github.com/getzep/graphiti), the engine under Zep, is Apache-2.0 and self-hosts, and its stated requirements are a graph database (Neo4j, FalkorDB, Amazon Neptune, or the deprecated Kuzu) plus an LLM key — it "defaults to OpenAI for LLM inference and embedding."

**Also worth naming: [OpenMemory MCP](https://github.com/mem0ai/openmemory/tree/main/openmemory-archive)** (Mem0, launched May 2025) shipped the same distribution idea — one local memory store shared across MCP clients — and Mem0 archived it; its README now opens "This project has been archived." Its schema is the contrast this table is about: [`models.py`](https://github.com/mem0ai/openmemory/blob/main/openmemory-archive/api/app/models.py) gives a memory `content`, `created_at`, `updated_at`, `archived_at`, `deleted_at` and a state, with no field for who asserted the fact and no valid time, and `content` is rewritten in place on update. It does keep a state-transition history and an access log, and it does have a ZIP export — so it is not the absence of portability that separates the two, it is provenance, valid time and an immutable raw.

Recall benchmarks (LOCOMO, LongMemEval, DMR) measure what an agent remembers. **None of them scores a memory system on provenance, invalidation or portability.** This library is built for that axis, and the conformance scorer below is one attempt at measuring it. The table is our reading of each project's own code and public docs, dated above; if we have a cell wrong, a PR with a link fixes it.

## Start here

An empty memory gives an assistant nothing to stand on. [docs/STARTER.md](docs/STARTER.md) seeds
yours in ten minutes: pin who the person is and how they want to be treated (including "never a
yes-person"), choose the rules the store enforces, and let it derive the rest nightly.

Upgrading from an earlier version: [CHANGELOG.md](CHANGELOG.md) marks anything that changes what
an existing caller gets back. 0.4.0 has breaking changes (immutable content, governed erasure, a new
`listNodes` on the store interface, the MCP exports moved to `al-buddy-memory/mcp`), so read that
entry before you upgrade.

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

Three policies ship to copy: personal defaults (secrets auto-classified Sensitive; Sensitive
facts never reach, leave with, or get erased by anyone but the owner in person; only the owner
changes a fact), guardian mode (only a guardian may write or
change a guardian's fact), enterprise audit (low-confidence inferences hidden from
non-reviewers; exports gated to exporters). A policy is a plain object with five
optional hooks; see [docs/GOVERNANCE.md](docs/GOVERNANCE.md).

Without any policy the store still guarantees: Sealed facts never surface in a search unless
asked for by classification; `provenance`, `nodeId`, `encryptionKeyRef`, raw `content` and the
anchor trail are immutable after write, through every path including import; every instant is
stored in one canonical UTC spelling. Two things it does not do, said plainly: provenance is what
the writer asserts (immutable once written, not verified — bind actors to provenance in a policy);
and `encryptionKeyRef` names a key you manage, it does not encrypt the file.

The governed handle is the boundary. `govern(store, …)` puts policies in front of every
operation that can change a fact or reveal one — including erasure, which is refused unless a
policy explicitly allows it. Whoever holds the inner store is not governed by anything, so hand
out the governed one.

The rules an assistant on this memory is held to are published in [docs/policies](docs/policies/README.md):
ethical behaviour, user sovereignty and privacy, lifecycle and guardians, data stewardship — and
[an honest ledger](docs/policies/ENFORCEMENT.md) of what the code enforces, what a prompt carries, and
what is still a person's decision. They change in the open.

## Limits, measured

One SQLite file, one process, one writer. Measured on an M1 Pro laptop with 100,000
facts (`bench/bench.mjs`, better-sqlite3, WAL):

| Operation (100,000 facts) | Measured |
|---|---|
| Insert, one fact per call | 5,400–5,900 facts/s (17–18 s for all 100k) |
| Keyword recall, top 10 (FTS5 + decay re-rank) | 30–50 ms median, ~150 ms worst of five terms; first query after open ~320–380 ms (cold cache) |
| Keyword recall through a governed handle, top 10 | ~75 ms for a word in 10% of facts, ~135 ms for two such words, ~850 ms for a word in every fact — see below |
| Recall by filters only, top 10 | 0.5–1 ms |
| Get by id | 0.1 ms |
| Invalidate a fact | 0.5 ms |
| File size | 69 MB |

Ranges are three runs of the same script on 0.4.0. Paging is exact: a page of ten is the
first ten of the full ordered read. When facts have genuinely decayed, the store may have to
read past its 200-row candidate pool to keep that promise — the worst case is a full read of
the matching facts (~300 ms at 100k), and it only happens when a decayed fact and a fresher one
would otherwise trade places.

A governed keyword search is slower on purpose. It reads every match, keeps the ones the
actor may see, and ranks them with word rarity counted over those visible matches alone: the
store's BM25 counts rarity across all facts, hidden ones included, so it would let a hidden
fact reorder visible results. At a personal memory's size (a few thousand facts) the speed
difference does not show, and a test holds its quality: twelve facts asked for in plain
questions ("what is the wifi login") among two hundred distractors all land on the first page.

What that means: a personal assistant or a single-tenant service will not notice the
store; a multi-tenant SaaS needs the Postgres backend on the roadmap. Node/TypeScript
only for now; the optional on-device embedder is a 25 MB model download.

### The semantic path costs more, and it is the honest weak spot

Everything above is the keyword path. Recall with an embedder wired goes through a
**brute-force linear scan**: every stored vector is read, parsed and scored against the
query. Measured the same way (`bench/bench-vectors.mjs`, 384-dimension vectors, the width
of the default on-device model), on the same laptop:

| With an embedder wired | 20,000 facts | 100,000 facts |
|---|---|---|
| File size (facts + vectors) | 172 MB | 864 MB |
| Of which vectors | 160 MB | 800 MB |
| Per vector, on disk | ~8.0 KB | ~8.0 KB |
| Semantic recall, top 10 — first of a session | 765 ms | 3,200 ms |
| Semantic recall, top 10 — thereafter | 36 ms median | 187 ms median |

Read that as a ceiling, not a benchmark win. Three things a reviewer should know:

- **Vectors are stored as JSON text**, so one 384-float vector costs about 8 KB instead
  of the 1.5 KB the same floats occupy as binary. That is where the file size goes: the
  same 100,000 facts are 69 MB without vectors and 864 MB with them. Storing the vector
  as a BLOB, and handing the search to `sqlite-vec` instead of scanning in JavaScript,
  is the obvious next move and is not done yet.
- **The scan is linear in the number of facts**, and the first call of a session pays to
  read and parse the whole vector table; later calls reuse a 60-second in-process cache
  and still score every vector. Both columns scale as you would expect — 5× the facts,
  ~4–5× the time.
- **The cache is disposable and model-tagged.** Vectors live in their own table keyed by
  `(nodeId, model)`; deleting them loses nothing but time, and a vector from a different
  model is skipped rather than compared. Upgrading the embedder is a re-index, never a
  migration. The facts-only sizes above are what the memory actually weighs.

If you are wiring an embedder over tens of thousands of facts, size the machine for the
table above, or keep to the keyword path until the BLOB-and-`sqlite-vec` work lands.

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

Score your own export the same way: `--format blocks` for block-style agent files, `--format records` for flat memory records, or paste it into the demo at [albuddy.com](https://albuddy.com).

Where the numbers come from, said plainly, because this is a scorer we also score
ourselves with. **Five of the seven** — provenance, since when, retire without erasing,
confidence, relations — are counted off the records in the file you paste; change the
sample and they move. **Two are not.** Whether a system keeps a retired fact, whether its
schema is published, and whether it itemises facts are properties of the *system*, which
no single export can prove, so the adapter author declares them in
`src/conformance/adapters.ts` and they show up verbatim in the report's reason line. The
one part that is executed rather than asserted is the round-trip: for our own format the
scorer imports your artifact into a fresh store, exports it again and compares — on your
file, and it says `lossy` if that fails.

The rulebook, including which dimension is which and what the score does **not** measure
(recall quality, truth, latency), is [docs/SCORING.md](docs/SCORING.md). The adapters are
written against export *shapes*, not vendors. If a system starts recording provenance, its
score goes up — that is the point. Add an adapter for your shape and open a PR; if you
think we declared a trait wrongly for yours, that is a one-line PR too.

## The governance MCP server

Most memory MCP servers hand the agent a fact.
This one hands it a fact **it can weigh**: every `recall` result carries `provenance`,
`validFrom`, `validTo`, `current`, `confidence`, and — for a superseded fact — the id of
what replaced it. `invalidate` closes a fact's validity and keeps the record; the server
has no erase tool. It serves a governed store: the owner's `personalDefaults` with the AI
client as the audience, so a secret an agent writes is classified Sensitive and kept out of
any AI's recall, and every call is audited beside the database.

```json
{ "mcpServers": { "memory": { "command": "npx",
    "args": ["-y", "--package=al-buddy-memory@0.4.1", "al-buddy-memory-mcp"] } } }
```

`al-buddy-memory-mcp` is an executable *inside* the `al-buddy-memory` package, not a
package of its own, so `--package=` is what tells npx where to find it — `npx
al-buddy-memory-mcp` looks for a package by that name and gets a 404. Drop the `@0.4.1`
to track the latest release instead of the one you tested.

The memory lands in `~/.al-buddy-memory/brain.db`; set `AL_BUDDY_MEMORY_DB` to put it
somewhere else. Give it an **absolute path** — a JSON config is not a shell, and a `~`
in it is expanded by this server but not by everything else that may read the value.
Beside the database, `brain.db.audit/` collects one hash-chained log per server process
(two assistants means two processes, and one chain has one writer); check them all with
`al-buddy-memory verify-audit ~/.al-buddy-memory/brain.db.audit`.

A `recall` result looks like this — every field an agent needs to decide how much to trust the fact:

```json
{ "id": "…", "text": "Lives in Tokyo", "provenance": "UserInput", "validFrom": "2026-06-01T00:00:00Z",
  "validTo": null, "current": true, "confidence": 1, "supersededBy": null, "derivedFrom": [] }
```

Tools: `remember`, `recall`, `invalidate`, `pin`, `unpin`, `pinned`. SQLite on disk, no
service, no key. The tool bodies are a plain function over a `MemoryStore`
(`governanceTools(...)`, exported from `al-buddy-memory/mcp`), so they run against any backend and test without a
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

The tests include a behavioural conformance suite every backend runs against itself.
