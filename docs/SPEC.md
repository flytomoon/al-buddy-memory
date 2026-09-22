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

Erasure wins over history. `deleteNode` removes the fact and its versions in one transaction, so no past `asOf` can resurrect an erased fact. On a governed handle, access is decided from the fact's current classification and current policy, on the same read of the fact that is served: a fact that is sealed today cannot disclose an older private copy, and a fact a policy redacts today has its history withheld entirely.

**Editing no longer removes anything.** Before 0.5.0, changing a fact's metadata overwrote the old value. Now the old value stays in the fact's history and is served to anyone who may read the fact today. Content was always immutable; the same is now true of every earlier state. To remove something from the past, erase the fact.

History cannot invent values that were never recorded, and says so when it cannot vouch for a read. A store writes a version only at the instant and event of an anchor it appends, so an imported or restored version that is dated before its fact was learned, or that records a change the fact's anchor trail never saw, is refused. A read is **exact** only when the recorded history accounts for the fact from that instant to now: the versions join end to end, the last one ends at the fact as stored, and every later change on the anchor trail has its own version (same instant, same event) and the reverse. Otherwise `getNodeAsOf` returns `exact: false` and `snapshotAsOf` lists the id in `inexact`, with the best state the history supports. That covers databases created before 0.5.0, changes made by an older library, a write policy that reshaped a fact on import, and an import over an existing fact, where the history is the two stores' histories joined: each part is what that store believed, and the join is marked.

With nothing recorded after `asOf`, the answer is the fact as it is stored: as of now is always the present.

As-of reads reconstruct in memory. This keeps the persistent representation and the verification rule simple, but its cost is linear in the facts and versions read. The measured cost is recorded in the README.

When a fact stops being true, set `validTo` rather than deleting it. Deletion is reserved for erasure.

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
