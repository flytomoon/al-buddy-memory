# Memory Schema — the contract

**Version:** 1.1.0
**Governance:** every node carries privacy classification, retention tier, provenance and an encryption key reference as required fields — governance is in the schema, not in a policy document beside it.
**Decision record:** [Memory architecture decision (2026-07-07)](./DECISION-2026-07-07.md)
**Implementation file:** `src/types/memory.ts`

---

## Overview

This memory schema is the contract that binds three system layers:

1. **Storage** — a local store (SQLite ships; the interface is storage-agnostic)
2. **API** — the `MemoryStore` interface every backend implements
3. **UI** — all present and future interfaces (terminal, mobile, web, embedded)

The schema is LLM-agnostic. Memory nodes carry no model-specific metadata. The system must be able to survive a complete LLM provider change without schema migration.

---

## Design Decisions

### 1. Nodes first, edges deferred (Phase 1 vs Phase 2)

The schema defines both `MemoryNode` and `MemoryEdge` types from day one, establishing the full contract. However, the **Phase 1 MVP** only requires implementations to persist edges — bidirectional graph traversal is a **Phase 2** capability.

**Why:** Standing up the full node schema now prevents a costly breaking migration when traversal ships. Traversal can be layered on without changing the storage contract.

### 2. All the required governance fields are required in Phase 1

The temptation in an MVP is to defer governance fields (`privacyClassification`, `retentionTier`, `encryptionKeyRef`) until they're "actively enforced." We did not do this.

**Why:** If these fields are optional in Phase 1, every node written without them becomes technical debt that requires a backfill migration before enforcement can go live. By making them required at creation time, enforcement in Phase 2 is a behavioral change, not a schema change.

The enforcement semantics (e.g., AI not reading `Sealed` nodes) live in the application layer, not the schema. The schema is structural.

### 3. `nodeId` is UUID v4, not a hash or content-derived ID

A node's raw content is immutable, but much else changes over its life (confidence, validity, retention tier, metadata), and an ID must survive all of it. A hash-based ID would also collide for two facts that happen to say the same words.

**Why:** UUID v4 gives stable cross-layer identity regardless of content state. `encryptionKeyRef` handles key derivation separately.

### 4. All timestamps are ISO 8601 strings, not `Date` objects

`Date` is a runtime construct that does not survive JSON serialization portably. Every instant is stored in one canonical spelling — `Date#toISOString()`: UTC, milliseconds, `Z` — so that a string comparison is a time comparison in every implementation; an instant without a zone is refused. (An RDF/JSON-LD serialisation is a goal, not a feature — see the deferred table below.)

**Why:** ISO 8601 strings are the open-standard representation. They serialize identically whether the runtime is Node.js, a mobile app, or a future Rust/Go service.

### 5. `temporalAnchors` is append-only

The temporal history of a memory node (when it was recalled, reinforced, archived) is audit data. It must not be overwritten.

**Why:** This array is the mechanism by which the system knows whether a node's `confidenceWeight` should decay or stay high. Truncating it would corrupt decay calculations.

### 6. `MemoryStore` interface is storage-agnostic

The interface does not reference Amazon Neptune, Neo4j, SQLite, or any other storage technology. Implementations may swap underlying stores without any API-layer changes.

**Why:** The system must survive technology shifts over decades — see §3 of the [technical governance policy](./policies/technical-governance-and-schema-evolution.md). The storage technology is an implementation detail; the schema is the contract.

### 7. Legacy `MemoryEntry` is preserved with `@deprecated`

The original flat `MemoryEntry` type is retained to avoid breaking any code written against the pre-1.0 schema. It will be removed in a future major version.

**Why:** Allows existing code to continue compiling during the transition. The `@deprecated` annotation signals to developers (and LSPs) to migrate.

### 8. Valid time and transaction time (1.1.0, 0.5.0)

Nodes have two independent time axes:

- **Valid time** uses `validFrom` / `validTo` to say when a fact was true in the world. A `validAt` query answers **what was true at Y**.
- **Transaction time** uses full before and after images recorded by every `updateNode`. An `asOf` read answers **what did the store believe at X**.

The two axes combine: `snapshotAsOf(X, { validAt: Y })` answers "what did the store believe at X about what was true at Y", filtering on the valid-time window the store held at X. Both boundaries are inclusive for changes: a version recorded exactly at `asOf` has happened, just as `validFrom <= validAt`. Validity ends remain exclusive.

Erasure wins over history. `deleteNode` removes the fact and its versions in one transaction, so no past `asOf` can resurrect an erased fact. (On a governed handle with Recently deleted, erasure happens at the purge, and the versions go then.) On a governed handle, access is decided from the fact's current classification and current policy, on the same read of the fact that is served: a fact that is sealed today cannot disclose an older private copy, and a fact a policy redacts today has its history withheld entirely.

**Editing no longer removes anything.** Before 0.5.0, changing a fact's metadata overwrote the old value. Now the old value stays in the fact's history and is served to anyone who may read the fact today. Content was always immutable; the same is now true of every earlier state. To remove something from the past, erase the fact.

History cannot invent values that were never recorded, and says so when it cannot vouch for a read. A store writes a version only at the instant and event of an anchor it appends, so an imported or restored version that is dated before its fact was learned, or that records a change the fact's anchor trail never saw, is refused. A read is **exact** only when the recorded history accounts for the fact from that instant to now: the versions join end to end, the last one ends at the fact as stored, and every later change on the anchor trail has its own version (same instant, same event) and the reverse. Otherwise `getNodeAsOf` returns `exact: false` and `snapshotAsOf` lists the id in `inexact`, with the best state the history supports. That covers databases created before 0.5.0, changes made by an older library, a write policy that reshaped a fact on import, and an import over an existing fact, where the history is the two stores' histories joined: each part is what that store believed, and the join is marked.

With nothing recorded after `asOf`, the answer is the fact as it is stored: as of now is always the present.

An imported artifact is trusted as the record of its own past. The checks above refuse history that contradicts the fact or comes from the future, but the first version's before-image is what the exporting store said it held, and nothing can check that from the file alone.

As-of reads reconstruct in memory. This keeps the persistent representation and the verification rule simple, but its cost is linear in the facts and versions read. The measured cost is recorded in the README.

When a fact stops being true, set `validTo` rather than deleting it. Deletion is reserved for erasure.

### 8a. When a fact a conclusion rests on goes (0.6.0)

A derived fact names its sources in `contextualMetadata.derivedFrom`. A source can go two ways,
and the store treats them differently on purpose:

| The source… | What happens to what was concluded from it |
|---|---|
| **stopped being true** (`updateNode` sets `validTo` where there was none) | Every conclusion still in force at that instant is **retracted, and kept**: its `validTo` becomes the source's, its text and history stay, and `contextualMetadata.retraction` records `{ at, by: "invalidation", reason: "a source stopped being true: <id>" }`. As-of reads still show what was believed and when it stopped. Transitive: a conclusion drawn from a retracted conclusion is retracted too. |
| **must not exist** (`deleteNode`) | The fact is **erased with everything built from it**, transitively, histories included, in one transaction. A conclusion that also cites a source that survives is still erased: its words may carry the erased fact, and what survives can be concluded again by the next pass, which reads only raw that exists. |

In short: stopped being true → kept, marked; must not exist → removed with everything built from it.

Two rules follow. Clearing the source's `validTo` later does **not** bring a retracted conclusion
back: it was withdrawn for a reason that has not been undone for it, and the next pass re-derives
what still holds. And `restoreNode` never cascades: an import restores a store's state as it was
written, conclusions and retractions included. Every `MemoryStore` must behave this way; the
conformance cases are in `src/derived-conformance.spec.ts`.

### 8b. A conclusion carries its evidence (0.6.0)

A derived fact records the words it rests on: `contextualMetadata.evidence` is an array of
`{ nodeId, quote }`, with at least one entry for every id in `derivedFrom`, and each `quote` must
appear in that source's `content.text` once line breaks and runs of whitespace are read as one
space. `consolidate()` refuses a conclusion that does not meet this, so a derived fact can always
be shown beside what it was drawn from. Raw text is immutable, so evidence that held when written
holds while the source exists; `verifyDerived()` re-checks it for what arrived by import or from
an older library, and retracts — never deletes — a conclusion whose evidence no longer holds.

### 8c. Mental models: standing questions with answers kept current (0.7.0)

A mental model is a question asked often enough that its answer should be ready before anyone asks.
It is stored as ordinary nodes, so nothing about it escapes the rules above:

- The **definition** is a node whose `contextualMetadata.mentalModel` holds `{ question, scope }`
  (scope: the tags and memory types of the facts that feed it). Its id is the model's id.
- Each refresh writes a new **answer** node: `provenance: "AIInferred"`, `mentalModelAnswer` naming
  the definition, `derivedFrom` and `evidence` exactly as for any conclusion (§8a, §8b). An answer
  whose quotes are not found in its sources is refused and the previous answer stays. The previous
  answer is closed (`validTo` = the refresh, `supersededBy` = the new one), never overwritten, so the
  model's valid-time history answers "what did we think then" (`mentalModelAsOf`).
- An answer is as restricted as the most restricted fact it rests on, never less than Private.
  Sealed facts are never shown to the judgement; Sensitive ones only when the host opts in.
- Because an answer is an ordinary conclusion, a fact that stops being true retracts the answer
  resting on it, and an erased fact erases it (§8a). The definition is never touched by either: the
  model reads as **stale** and the next refresh answers it again.
- Freshness is decided on read, with no model call: not answered yet; its newest answer retracted,
  or not available to this reader (a governed read cannot tell erased from withheld, so it names
  both); or facts in scope that the answer was never shown. A stale model still returns its last
  readable answer, marked.
- Mental-model nodes are never fed to consolidation or to another model's refresh.

Refresh is host-driven: `refreshMentalModels(store, { propose })` batches every stale model into
one judgement call; schedule it beside consolidation (nightly) or run it on demand.

### 8d. Current state: one live memory per subject (0.8.0)

Much of what an assistant is asked about changes: a release, a launch date, where something is
hosted. As ordinary facts every status note stays valid forever, and recall ranked by wording will
happily repeat the oldest one. A **state** memory declares what it is the state of:

- `contextualMetadata.stateOf = { subject, aspect?, aliases?, key }`, plus the tag `state`. The
  `key` is the subject and aspect with case, spacing and punctuation removed, so "Al Buddy Memory"
  and "al-buddy-memory" are one subject.
- `recordState` closes every live state with the same key that began at or before the new one
  (`validTo` = the new state's `validFrom`, `supersededBy` = its id). Nothing is deleted; a
  valid-time read at any instant returns the state that held then.
- A state that arrives late — its `at` is earlier than a live state already recorded — is stored
  already closed by that newer state. Late news never overturns newer news.
- Recording the text the newest state already holds changes nothing.
- Only state memories are ever closed by this. Supersession is by declared key, or by the caller
  naming the states it replaces (`replaces`: live states that began at or before the new one, under
  any key). A caller usually gets those ids by showing a model the subject's current states and
  asking which the new one replaces, the same check graph memories run against existing facts.
- `supersedeState(old, by)` closes one live state in favour of a later live one, for a tidy pass
  that finds two names for one thing after the fact. The old state ends when its replacement began.

`statesMentionedIn(states, text)` returns the states whose subject or alias the text names, as
whole words in order ("the total" does not name "Al"). Hosts put these in front of the model,
ahead of older notes, as "where things stand now".

Recall's `freshness` weight fuses a recency ranking into the keyword and vector lists. It reorders
only facts the query already matched and is off by default.

### 9. Embeddings are a model-tagged, disposable cache — not node state (1.1.0)

Vectors live in a dedicated {@link MemoryEmbedding} side store keyed by `(nodeId, model)`, each tagged with the model + version that produced it. Inline `MemoryNode.embedding` is deprecated. `content.text` is the only source of truth.

**Why:** Embedding models change; two models' vectors are not comparable. Keeping vectors inline welds the memory to one model and one moment. As a separate, per-model cache, upgrading the embedding model is a re-index (`setEmbedding` again), never a data-loss migration — the memory itself is untouched. This is the portability insurance called out in the [decision record](./DECISION-2026-07-07.md).

---

## Phase Roadmap

### Phase 1 — MVP (current)

| Capability                                                    | Status                                                                    |
| ------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Full `MemoryNode` schema (all the required governance fields)        | ✅ Required                                                               |
| `MemoryEdge` schema                         | ✅ Defined; persist only                                                  |
| `PrivacyClassification` field                                 | ✅ Required; informational                                                |
| `RetentionTier` field                                         | ✅ Required; informational                                                |
| `encryptionKeyRef` field                                      | ✅ Required; key management TBD                                           |
| Valid time (`validFrom`/`validTo`) + `validAt` query          | ✅ Stored, queryable (1.1.0)                                              |
| Queryable transaction time ("what did we believe at X")       | ✅ Full before/after versions and as-of graph reads (0.5.0)               |
| Model-tagged embedding store (`setEmbedding`/`getEmbeddings`) | ✅ Interface + store (1.1.0); vectors populated when an embedder is wired |
| Inline `MemoryNode.embedding` field                           | ⚠️ Deprecated (1.1.0) — use the embedding store                           |
| `MemoryStore` interface                                       | ✅ Full interface defined                                                 |
| Graph traversal (edge queries beyond `getEdges`)              | Deferred                                                                  |
| Active `Sealed` node enforcement in AI context                | Deferred                                                                  |
| Automated decay/archival pipeline                             | Deferred                                                                  |

### Phase 2 — Graph & Enforcement

| Capability                              | Notes                                                          |
| --------------------------------------- | -------------------------------------------------------------- |
| Bidirectional graph traversal           | Needs an edge-query API over the existing store — recursive SQL is enough; a graph database is one option, never a requirement (see §6) |
| Active privacy-tier enforcement         | `Sealed` → excluded from AI context window                     |
| `Sensitive` → opt-in summarization gate | Requires user-facing confirmation UI                           |
| Automated decay → `Archived` transition | the governance fields §3.5: notify at day 160, confirm before transition |
| Narrative preservation summaries        | the governance fields §3.6: `memoryType: "Narrative"` nodes              |
| Full RDF/JSON-LD export                 | Open-standard portability                                      |

---

## Node Type Reference

| Type           | Description                                    | Typical provenance        |
| -------------- | ---------------------------------------------- | ------------------------- |
| `Experience`   | Episodic — something that happened             | `UserInput`, `AIInferred` |
| `Lesson`       | Semantic — something learned                   | `UserInput`, `AIInferred` |
| `Conversation` | Verbatim or summarized dialogue                | `SystemGenerated`         |
| `Belief`       | Value, opinion, or conviction                  | `UserInput`               |
| `Relationship` | A person, group, or entity the user relates to | `UserInput`, `AIInferred` |
| `Skill`        | Procedural — something the user can do         | `UserInput`, `AIInferred` |
| `Narrative`    | Long-form prose preservation summary (§3.6)    | `SystemGenerated`         |

## Edge Type Reference

| Type            | Direction semantics                        |
| --------------- | ------------------------------------------ |
| `Cause`         | Source caused target                       |
| `Analogy`       | Source is analogous to target              |
| `Reinforcement` | Source strengthens or confirms target      |
| `Contradiction` | Source conflicts with target               |
| `Temporal`      | Source precedes target chronologically     |
| `Emotional`     | Source has emotional connection to target  |
| `Conceptual`    | Source and target share a conceptual theme |

---

## Schema Evolution

All schema changes are governed by the [Technical Governance & Schema Evolution Policy](./policies/technical-governance-and-schema-evolution.md). New fields require:

1. A versioned migration tool
2. Human review gate before activation
3. Backward-compatible defaults for any new required field

The `@version` JSDoc tag on `memory.ts` must be incremented on any structural change.

### SQLite migrations

`SqliteMemoryStore` applies ordered migrations keyed on `PRAGMA user_version` (see the `MIGRATIONS` array). Each entry brings the database from version _N_ to _N+1_ inside a transaction; a store opened against an older file upgrades itself on construction. **Never edit a shipped migration — append a new one.** The 1.1.0 change is migration `v2`: it adds `valid_from`/`valid_to` (backfilling `valid_from = created_at` for pre-existing rows) and the `memory_embeddings` table.
