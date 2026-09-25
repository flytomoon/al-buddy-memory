# al-buddy-memory

[![Listed on mcpservers.org](https://mcpservers.org/badge.svg)](https://mcpservers.org/servers/flytomoon/al-buddy-memory)

> **Al Buddy** — that's *Al*, a name, said like "pal". Not A.I.

### A memory that's yours.

**Portable, governed, model-agnostic memory for AI agents.**

A fact is invalidated, never overwritten; on a governed handle, erasure runs through policy and is audited. Raw text is the source of truth and cannot be edited. Embeddings are a disposable, model-tagged cache. Every fact and every link exports to one documented format. The memory outlives whatever model, runtime or company produced it.

---

## Why this exists

Every agent-memory product on the market answers one question well: *what does the agent recall?* None of them answers the four questions that decide whether you can trust and keep that memory:

| Question | This library | Letta | Mem0 | Zep |
|---|---|---|---|---|
| **Where did this fact come from, and who asserted it?** | Provenance on every node and edge (`UserInput` / `AIInferred` / `GuardianAdded` / `SystemGenerated`) | Memory-file git history | Metadata field | Graph episodes |
| **When was it true, and what replaced it?** | Two queryable axes: `validAt` answers what was true at Y; `getNodeAsOf` / `snapshotAsOf` answer what the store believed at X from full before/after versions. They combine in one call (`snapshotAsOf(X, { validAt: Y })`), a read the history cannot vouch for is marked, and erasure removes the history too | Git history of files, not a fact model | Change history per memory (`history()`: old value, new value, event, timestamps) — transaction history, not valid time | Temporal graph (its real strength): Graphiti edges carry `valid_at` / `invalid_at` alongside `created_at` / `expired_at` |
| **Can I take it with me, losslessly, to another runtime?** | One versioned JSON export with a published schema and conformance tests | `.af` (agent state, framework-shaped, archival memory not yet included) | Cloud export | Cloud-only since 2025 |
| **Does it run with no vendor, no key, no server?** | SQLite on disk, on-device embeddings | Self-host possible; cloud is the product | Self-host possible (Apache-2.0, local vector stores); needs an LLM for extraction; cloud is the product | Zep is cloud; Graphiti self-hosts (graph DB + LLM key required) |

Sources for the cells above, each checked against the project's own code or announcement on 2026-09-18: Mem0's per-memory history is a SQLite table with `old_memory`, `new_memory`, `event`, `created_at`, `updated_at` ([`mem0/memory/storage.py`](https://github.com/mem0ai/mem0/blob/main/mem0/memory/storage.py)); Mem0 is Apache-2.0 and runs against local vector stores including Qdrant, Chroma, pgvector and FAISS ([vector-store docs](https://docs.mem0.ai/components/vectordbs/overview)), with an LLM called to extract facts on the default `add()` path. Zep stopped maintaining Community Edition on 2025-04-02, in [its own words](https://blog.getzep.com/announcing-a-new-direction-for-zeps-open-source-strategy/): *"we've decided to stop maintaining and releasing Zep Community Edition."* [Graphiti](https://github.com/getzep/graphiti), the engine under Zep, is Apache-2.0 and self-hosts, and its stated requirements are a graph database (Neo4j, FalkorDB, Amazon Neptune, or the deprecated Kuzu) plus an LLM key — it "defaults to OpenAI for LLM inference and embedding."

**The three local, keyless ones people will name**, read against their own code on 2026-09-21. They answer the fourth question the way this library does — your machine, your files, no account — and they are the honest comparison, not the cloud products.

- **[basic-memory](https://github.com/basicmachines-co/basic-memory)** (AGPL-3.0; Markdown notes on disk are the truth, SQLite is a rebuildable index). **It has valid time, and that is worth saying plainly:** an observation can carry `@effective[2026-06-10,2026-07-27)` in the note itself, parsed into a time index ([`models/knowledge.py`](https://github.com/basicmachines-co/basic-memory/blob/main/src/basic_memory/models/knowledge.py)) and rebuilt from the file, so the file stays the source of truth. What it does not carry on a local install is who asserted a fact: `created_by` / `last_updated_by` exist and hold a cloud user id, null for local and CLI use. Portability is the strongest kind and the least specified: the notes *are* the format, so nothing is trapped, and there is no versioned schema to import them into something else. Capture and full-text search need no key; semantic search is opt-in and does.
- **[The MCP memory server](https://github.com/modelcontextprotocol/servers/tree/main/src/memory)** (the reference implementation most agents meet first; one JSONL file). Entities, relations and observations, and nothing else: no field for who said it, no timestamps at all, and `deleteObservations` filters the old value out of the array, so what was true before is gone rather than closed. The file is its own export. Nothing calls a model; nothing leaves the machine.
- **[Memori](https://github.com/GibsonAI/Memori)** (Apache-2.0; your own SQL database — SQLite, Postgres, MySQL, Oracle). A fact in `memori_entity_fact` has content, an embedding, a count and a last-seen date; who asserted it is only recoverable by walking the foreign keys back to a conversation message, not a property of the fact, and there is no valid time — `date_updated` replaces. "Your data stays in your database" is the portability story, with no interchange format published. It is local in the sense that matters for your data, but capture is not keyless: extraction and embeddings call an LLM, and the default SDK path expects a Memori account as well.

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
- `verifyDerived`: every conclusion stores the exact words it rests on (`evidence`), checked when it is written; this re-checks them any time, and retracts, never deletes, one whose evidence no longer holds.
- Mental models: standing questions with answers kept current in the background, so reading one costs no model call (`defineMentalModel`, `refreshMentalModels`, `getMentalModel`). Every answer quotes the facts it rests on, keeps its history ("what did we think in June"), and reads as stale the moment one of those facts stops being true or is erased.
- Current state: "where does X stand now?" held as one live memory per subject (`recordState`, `currentStates`, `statesMentionedIn`). A newer state closes the one it replaces and keeps it as history; a state that arrives late never overturns a newer one. Recall can also weigh recency (`freshness`), so the newest of several matching notes comes first.
- `explainFact`: why a fact is believed, in one call — provenance and origin, validity and what replaced it, a conclusion's evidence with each quote checked, and its history. Through a governed handle a source the reader may not see is named as withheld, never shown.
- Conclusions go with their facts: a fact that stops being true retracts what was concluded from it (kept, marked); a fact that is erased takes everything built from it (SPEC §8a).
- `listConsolidations` / `undoConsolidation`: review what each pass concluded, with the evidence for every fact, and take back one pass's conclusions. Undo retracts (`validTo`) and records who withdrew each fact and why; it never deletes, so the history still shows what was believed, when it was withdrawn, and the reason.
- `buildSourceProvenance` / `readSourceProvenance`, `renderMemoryBlock`, `exportMemoryMarkdown`, decay helpers.
- Integrations: `al-buddy-memory/ai-sdk` (Vercel AI SDK tools + middleware), `al-buddy-memory/langchain` (a LangGraph long-term memory store + LangChain tools), `al-buddy-memory/mastra` (an input processor + tools). The frameworks are optional peer dependencies; every write is governed and records which agent made it. Guides in [docs/integrations](docs/integrations/).

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
import { SqliteMemoryStore, govern, personalDefaults, storeAudit } from "al-buddy-memory";

const inner = new SqliteMemoryStore("brain.db");
const store = govern(inner, {
  policies: [personalDefaults({ owner: "chris" })],
  context: () => ({ actor: currentActor() }),
  // The trail goes in the database, hash-chained, in the same transaction as
  // the fact it describes. `new ChainedAudit("audit.jsonl")` puts it in a file
  // instead — for a store that is not SQLite, or when you want it outside the
  // file it describes. See docs/GOVERNANCE.md for what each one proves.
  audit: storeAudit(inner),
});
```

To make sure nothing is ever erased by accident, add `memoryLock()` to the policies: while it
is there, erasure is refused for everyone, the owner included, until you take it out (or flip
the switch it reads). Invalidating a fact still works; that is not erasure. The raw store and
the database file are outside any policy, so keep backups.

And to make a deletion something you can take back, pass `recentlyDeleted: { days: 14 }` to
`govern()`: a delete then moves the fact out of recall for 14 days, `restoreDeleted` brings it
back, and `purgeDeleted` erases it for good once the days are up (asking the policies again, so
the lock still wins). Nothing runs on a timer, and until it is purged the fact is still in
exports and backups.

Check the trail with `al-buddy-memory verify-audit brain.db`. It names the first event that
was edited, removed, inserted or reordered. What it establishes, and the two things it does
not, are written out in [docs/GOVERNANCE.md](docs/GOVERNANCE.md#what-verification-establishes) —
short version: the chain is tamper-*evident*; a tail cut off a **log file** is invisible to it,
a tail cut off the **table** is caught as long as nobody resets the table's own counter, and
only a head you anchor somewhere else catches a rewrite or a restored backup.

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
| Reconstruct `snapshotAsOf` | 2.19 s with 100,001 versions |
| File size | 69 MB for the 100,000 facts; each recorded change adds ~738 bytes (140 MB after one update to every fact) |
| Audit event into `audit_events`, in the fact's own transaction | +0.04 ms per governed write, +0.5 ms per governed read (a read is audited too, so it takes the write lock briefly) |
| Checking the chain — `verify-audit <db>` | linear, ~3 µs/event: 83 ms at 20,000 events, 325 ms at 100,000, 1.5 s at 500,000. Each process pays it once, before its first governed write and **outside** the write transaction, so it delays that process and blocks no other. Constant memory (the walk streams) |
| How fast the trail grows | one event per governed write, one or two per governed read — a `remember` is +2, a `recall` +1. Nothing prunes it. At 500,000 events the trail is ~128 MB, which can exceed the facts it describes; if you drive a store that hard, keep an eye on it |

Ranges are three runs of the same script on 0.4.0. Paging is exact: a page of ten is the
first ten of the full ordered read. When facts have genuinely decayed, the store may have to
read past its 200-row candidate pool to keep that promise — the worst case is a full read of
the matching facts (~300 ms at 100k), and it only happens when a decayed fact and a fresher one
would otherwise trade places.

The transaction-time measurement is one run on the same M1 Pro: 100,000 facts,
one recorded reinforcement per fact, and one earlier invalidation. Reconstructing all
100,000 facts from 100,001 versions took 2.19 s. It is an in-memory linear reconstruction,
not an indexed point lookup.

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

Read that as a ceiling, not a benchmark win.

**And the brute-force scan is not what costs.** That is worth stating plainly, because it
is the obvious suspect and it is wrong. Timing a cold call stage by stage at 100,000 facts,
two runs on the same laptop (the second 2026-09-19):

| Stage of one cold semantic recall, 100,000 facts | Measured |
|---|---|
| SQL read of the vector table | 978–1,182 ms |
| `JSON.parse` of those rows | 1,418–1,744 ms |
| Cosine scan of all 100,000 vectors | 85–127 ms |
| The whole call, cold, end to end | 3,650–4,170 ms |
| Per vector, stored as JSON text | 8,003 bytes |

Reading the rows and parsing them is **95–96%** of those three stages; the scan everyone
assumes is the bottleneck is about 4%. Three things follow:

- **Vectors are stored as JSON text**, so one 384-float vector costs 8,003 bytes instead
  of the ~1.5 KB the same floats occupy as binary. That is where the file size goes — the
  same 100,000 facts are 69 MB without vectors and 864 MB with them — and, per the table,
  it is also where the *time* goes, because those 8 KB rows have to be read and parsed.
- **So BLOB storage is the move, and `sqlite-vec` is not — at this size.** Storing the
  vector as a `Float32Array` BLOB removes the parse entirely and shrinks the read by
  roughly 5×, which is where 95% of the cost sits. Handing the search to `sqlite-vec`
  would attack the 85–127 ms scan, which is not the problem yet. Both those figures are a
  **projection from the table above, not an achieved result**: neither is built, and no
  number in this README comes from a BLOB implementation.
- **The cache is disposable and model-tagged.** Vectors live in their own table keyed by
  `(nodeId, model)`; deleting them loses nothing but time, and a vector from a different
  model is skipped rather than compared. Upgrading the embedder is a re-index, never a
  migration. The facts-only sizes above are what the memory actually weighs.

The scan is still linear in the number of facts, and a session's first call pays for the
whole vector table; later calls reuse a 60-second in-process cache and still score every
vector. If you are wiring an embedder over tens of thousands of facts, size the machine for
the table above, or keep to the keyword path until the BLOB work lands.

### Backups, restores and synced folders

A SQLite database in WAL mode is **three** files — `brain.db`, `brain.db-wal`, `brain.db-shm` —
and two ordinary habits will quietly lose a person's memory:

- **Restoring a backup:** stop the server first, then delete `brain.db-wal` and
  `brain.db-shm` before you copy the backup into place. A `-wal` left beside a restored
  file is replayed over it on the next open, so the restore appears to succeed, reports no
  error, and leaves you with the data you were trying to replace. Verified, 2026-09-19.
- **Which backup command:** `sqlite3 brain.db ".backup out.db"` and
  `VACUUM INTO 'out.db'` are the safe ones — both take a consistent snapshot of a live
  database, verified while another process was writing. `sqlite3 .dump` works too, but it
  does not carry `user_version`; before 0.4.2 a restored dump could not be opened at all
  (`duplicate column name: valid_from`), and now it migrates cleanly. Never back up by
  `cp`-ing a live database: a copy taken mid-write can be unreadable, and a readable one
  can still fail `PRAGMA integrity_check`.
- **Synced folders:** never put the database in iCloud, Dropbox, OneDrive or Google Drive.
  WAL mode assumes one machine coordinating its own locks; a sync client copying
  the three files independently, or two machines writing through one folder, corrupts the
  file rather than conflicting visibly. Back the folder up by all means — copy it out on a
  schedule, or use `.backup`/`VACUUM INTO` — but do not let a sync client own the live file.

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
`validFrom`, `validTo`, `current`, `confidence`, which assistant wrote it and which retired
it, and — for a superseded fact — the id of what replaced it. `invalidate` closes a fact's validity and keeps the record; the server
has no erase tool. It serves a governed store: the owner's `personalDefaults` with the AI
client as the audience, so a secret an agent writes is classified Sensitive and kept out of
any AI's recall, and every call is audited — into the database itself, in the same
transaction as the fact.

```json
{ "mcpServers": { "memory": { "command": "npx",
    "args": ["-y", "--package=al-buddy-memory@0.7.0", "al-buddy-memory-mcp"] } } }
```

`al-buddy-memory-mcp` is an executable *inside* the `al-buddy-memory` package, not a
package of its own, so `--package=` is what tells npx where to find it — `npx
al-buddy-memory-mcp` looks for a package by that name and gets a 404. Drop the `@0.7.0`
to track the latest release instead of the one you tested.

> **Releasing?** This pin is a documented version and goes stale the moment a new one
> publishes — the example would then install an older server than the page describes.
> **Advance it in the same commit as the version bump** — it has been, at 0.4.2 and 0.5.0, and was
> `@0.4.1` while 0.4.1 was current. Running the pinned command against a newer release
> returns the older server's handshake, which is how a reader ends up reading documentation
> that does not match what they just installed (Astra release review, 2026-09-19).

The memory lands in `~/.al-buddy-memory/brain.db`; set `AL_BUDDY_MEMORY_DB` to put it
somewhere else. Give it an **absolute path** — a JSON config is not a shell, and a `~`
in it is expanded by this server but not by everything else that may read the value.
The audit trail goes inside that database, in `audit_events`, appended in the same
transaction as the fact it describes — one hash chain however many assistants are running.
Check it with `al-buddy-memory verify-audit ~/.al-buddy-memory/brain.db`. A server from
before the table left one log per process in `brain.db.audit/`, and one before that a
single `brain.db.audit.jsonl`; those are neither adopted nor
extended (they attest to a period the table cannot, and vice versa) and the same command
reports them alongside the table. `AL_BUDDY_MEMORY_AUDIT` still names a JSONL file to use
instead — one process per file if you do.

A `recall` result looks like this — every field an agent needs to decide how much to trust the fact:

```json
{ "id": "…", "text": "Lives in Tokyo", "provenance": "UserInput", "validFrom": "2026-06-01T00:00:00Z",
  "validTo": null, "current": true, "confidence": 1, "supersededBy": null, "derivedFrom": [],
  "recordedAt": "2026-06-01T00:00:00Z",
  "origin": { "app": "claude-desktop", "appVersion": "1.2.3", "via": "mcp" }, "retiredBy": null }
```

`origin` is which assistant wrote the fact, taken from the MCP handshake rather than from
the model, and `retiredBy` is which one closed it — so on memory genuinely shared between
assistants, a retired fact is an event with an actor. Both are `null` when the host knew
nothing.

**`remember` answers "what might this replace?"** It returns the fact it stored plus
`mayConflictWith`: up to three current facts that read like the new one, each with its id,
text and `validFrom`.

```json
{ "id": "…", "text": "Lives in Berlin", "…": "…",
  "mayConflictWith": [ { "id": "…", "text": "Lives in Tokyo", "validFrom": "2026-06-01T00:00:00Z" } ] }
```

Nothing is retired automatically — the client reads them and calls `invalidate` on the ones
that stopped being true. That is the whole invalidate-never-overwrite loop, and until 0.4.2
nothing in the surface ever prompted it. Treat the list as facts to *read*: they are the
best lexical matches, not conflicts that were proven.

The **first** `recall` of a connection also returns the pinned tier — the person's standing
rules — as a second content block, so the tier that claims to be in every prompt gets there
without spending any of the 512-character handshake.

Tools: `remember`, `recall`, `history`, `explain`, `invalidate`, `pin`, `unpin`, `pinned`, `mental_model`, `define_mental_model`. `mental_model` reads a standing question's pre-written answer with its freshness and evidence (the host refreshes answers on its own schedule). `explain` answers why a
fact is believed: who asserted it, when it was true, what ended it, and for a conclusion the exact
words it rests on, each checked now. `remember` takes at
most 4,000 characters and `pin` 500; a `recall` query 1,000, an `invalidate` reason 500, and
an id 128. `pin` refuses text that reads like a secret, because the server would store it
Sensitive and no assistant could see it. `invalidate`'s `replacedBy` must name a fact the
caller can see. SQLite on disk, no service, no key. The tool bodies are
a plain function over a `MemoryStore` (`governanceTools(...)`, exported from
`al-buddy-memory/mcp`), so they run against any backend and test without a transport.

## Roadmap

- [x] The spec and the portable format, published and versioned (this repo)
- [x] `al-buddy-memory conformance <export>`: score any memory export on provenance, invalidation and portability, with adapters for block-style agent files and flat memory records (v0.2.0)
- [x] The governance MCP server: a memory server that returns provenance and validity with every fact (v0.2.0)
- [x] Governance hooks with an audit trail and three sample policies; provenance immutable at runtime; measured limits at 100k facts (v0.3.0)
- [x] The audit event committed in the same transaction as the fact it describes, as one chain many processes share (v0.4.2)
- [x] A comparison table and a live paste-your-export demo (albuddy.com)
- [x] Transaction time, the second half of bi-temporal: "what did we believe at X", including a fact held wrongly and later corrected (v0.5.0)
- [ ] A Postgres backend behind the same `MemoryStore` interface, for multi-tenant and hosted deployments (SQLite stays the local-first default; the interface is small and the conformance suite is what a backend must pass)
- [ ] Framework integrations (LangChain, CrewAI, Vercel AI SDK)

## Development

```sh
npm ci
npm run check   # typecheck, tests, and the browser bundle — exactly what CI runs
```

The tests include a behavioural conformance suite every backend runs against itself.
