# Postgres backend

`PostgresMemoryStore` implements `MemoryStore`, `SnapshotCapable`, `HistoryCapable`, and `AuditCapable`. SQLite remains the local default. The backend uses the Node `pg` driver and requires Postgres with pgvector 0.8 or newer.

```ts
import { PostgresMemoryStore, govern, storeAudit } from "al-buddy-memory";

const store = new PostgresMemoryStore({
  connectionString: process.env.DATABASE_URL!,
  tenantId: authenticatedTenantId,
  indexedDimensions: 1536,
});
await store.initialize();
const governed = govern(store, { policies, context, audit: storeAudit(store) });
// Use governed for application reads and writes.
await store.close();
```

The caller supplies a stable tenant key from its authenticated context. Every table read and write includes this key; the `memory_items` table also has an `owner_key`. Each tenant's mutations lock its row in `memory_tenants`, so concurrent writers serialize without locking unrelated tenants. All facts, edges, versions, and embeddings use one shared `memory_items` shape: `id`, tenant and owner keys, JSONB metadata, a pgvector column, and a generated `tsvector` with a GIN index. Embeddings stay a disposable, model-tagged cache; raw text is immutable. A fixed-dimension HNSW cosine index covers the configured `indexedDimensions`; vectors of other dimensions remain stored and available through the existing embedding API. Search transactions set `hnsw.iterative_scan = strict_order` so filtered approximate vector searches can continue scanning. Keyword search uses `ts_rank_cd` per matching row after tenant, classification, retention, tag, confidence, and valid-time filters. The governance wrapper still re-ranks over policy-visible text for actor-specific filtering or redaction.

`searchSimilar(model, modelVersion, vector, filters)` on the Postgres class uses the HNSW index for the configured dimension. It applies tenant and node visibility filters before the result limit. The existing hybrid retriever continues to use the `MemoryStore` embedding API and scans vectors; callers that need indexed cosine search can use this Postgres-specific method directly.

A policy's [data boundary](policies/boundaries.md) reaches Postgres as the `labels` option of `searchNodes` and `searchSimilar`, and is compiled into the same `WHERE` as the tenant and visibility filters: labels are read with `contextualMetadata -> $n`, values are bound as a `text[]` parameter, and nothing from the rule is spliced into SQL. It therefore applies before `LIMIT`, so the nearest or best facts inside the boundary come back even when nearer ones sit outside it. Row-Level Security is not used for it: a write must see every row it can reach, whichever boundary that row is in (an erasure takes the conclusions drawn from a fact, an invalidation retracts them), so an RLS policy on the store's own role would break writes. A separate read-only role with its own RLS policy remains possible for reporting tools that query the table directly.

`validTo` invalidation updates the original row and records a version. Physical deletion occurs only through the explicit erasure API and removes dependent edges, versions, and embeddings. `storeAudit(store)` appends events in the same transaction as a governed mutation. Audit hashes are tenant-specific. Each store object walks its tenant's whole chain once, before its first append and outside the tenant lock (as the SQLite store does); every append then checks that the newest event is the one the tenant row's head and count record, which catches a trail deleted or cut from the end. An edit in the middle of the chain after that first walk is found by `verifyAudit`, not by the next append. Anchor `auditHead()` outside the database if a database owner's deliberate rewrite must be detectable.

`verifyAudit({ head? })` checks one tenant's chain from an open store, in a read-only snapshot: every link, then the tenant row's count and head. It writes nothing, and a tenant with no row is reported rather than created. From the command line: `DATABASE_URL=... al-buddy-memory verify-audit --postgres --tenant <key>` (the HMAC key, if any, from `AL_BUDDY_MEMORY_AUDIT_KEY`).

[Erasure by label](ERASURE.md) (`eraseWhere`) works the same on Postgres as on SQLite — the parity test holds the receipts equal — and its receipt checks against the tenant's chain with `verifyErasureReceipt(receipt, store)` or `verify-audit --postgres --tenant <key> --receipt receipt.json`. Erased rows stay in the table's dead tuples until VACUUM, and in any backup or replica taken before; the receipt says so.

At-rest encryption is the database operator's responsibility: configure Aurora or Postgres storage encryption with KMS-managed keys, encrypted backups, and TLS connections. `encryptionKeyRef` remains immutable provenance metadata; this backend does not add column encryption.

`initialize()` creates the extension, tables, and indexes and must run before using a new database; run it again after upgrading, as it adds the indexes the write path below looks up by. It requires schema-creation privileges; grant the runtime role only the permissions it needs after migration.

The test suite uses in-process PGlite with its pgvector extension. No Docker or network service is required. `npm run check` runs the shared `MemoryStore` conformance suite against it, and the derived-facts and mental-model suites.

## What a write costs

A write locks its tenant's row, reads only the rows it acts on, applies the same domain rules as the in-memory store to them, and persists the rows that changed, all in one transaction. What it reads:

| Call | Rows read |
|---|---|
| `addNode` | none |
| `updateNode`, `restoreNode`, `restoreVersion` | the fact and its versions (and the fact holding a restored version's id) |
| an invalidation (`updateNode` that sets `validTo`) | also every fact concluded from it, directly or through another conclusion |
| `deleteNode` (erasure) | the fact, every conclusion drawn from it, and every edge touching any of them, with the edges' other endpoints |
| `addEdge`, `restoreEdge`, `deleteEdge` | the edge and its two endpoints |

Each lookup is by key or by an index `initialize` creates: versions and embeddings by fact, edges by either endpoint, and a GIN index over `contextualMetadata.derivedFrom` that holds only conclusions. A write's cost therefore depends on how much it touches (a fact's versions, its conclusions, its edges), not on how many facts the tenant holds. The governed handle asks the store for a fact's conclusions by the same index before an erasure or an invalidation (`nodesRestingOn`), rather than listing the tenant.

Measured with `node bench/postgres-writes/run.mjs 1000,10000,100000 20` after `npm run build` (in-process PGlite with pgvector, Apple silicon, Node 25; median of 20 writes, each on its own block of ten facts shaped like every other; result in [`bench/results/2026-10-08-postgres-writes.json`](../bench/results/2026-10-08-postgres-writes.json)):

| Write | 1,000 facts | 10,000 | 100,000 | Rows read |
|---|---|---|---|---|
| `addNode` | 1.11 ms | 0.89 ms | 0.87 ms | 1 |
| `updateNode` | 2.17 ms | 2.00 ms | 1.78 ms | 3 |
| invalidation | 3.33 ms | 3.52 ms | 2.76 ms | 5 |
| `addEdge` | 1.55 ms | 1.63 ms | 1.36 ms | 3 |
| `deleteEdge` | 1.53 ms | 1.57 ms | 1.36 ms | 4 |
| `restoreNode` | 1.82 ms | 1.78 ms | 1.71 ms | 2 |
| `deleteNode` | 3.20 ms | 3.13 ms | 3.12 ms | 7 |
| governed `updateNode`, audited | 3.70 ms | 3.35 ms | 3.31 ms | 5 |
| governed invalidation, audited | 6.34 ms | 5.88 ms | 5.81 ms | 13 |
| governed `deleteNode`, audited | 6.28 ms | 6.06 ms | 5.84 ms | 15 |

Before this change a write rebuilt the tenant's whole graph: on the same blocks, a plain write took about 33 ms at 1,000 facts, 155 ms at 5,000 and 640 ms at 20,000, and a governed invalidation 1.4 s at 20,000. `src/postgres-write-cost.test.ts` holds the new behaviour: tenants of 1,000 and 20,000 facts take the same writes, and each must return exactly the same rows at both sizes and stay within 3x the median time.

What these numbers do not cover. PGlite runs inside the process on one connection, so a networked server adds a round trip per query (a plain write sends 4 to 14, an audited governed one up to 28), and concurrent writers to one tenant queue on its lock. A write that touches a fact with many versions, conclusions or edges reads all of them. Calls that answer about a whole tenant still read all of it: `listNodes` (facts only), `snapshot`, `historySnapshot`, `snapshotAsOf`, the selection step of `eraseWhere`, and Recently deleted's purge. A new store object's first audited write walks the tenant's audit chain once.