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

A policy's [data boundary](policies/boundaries.md) reaches Postgres as the `labels` option of `searchNodes` and `searchSimilar`, and is compiled into the same `WHERE` as the tenant and visibility filters: labels are read with `contextualMetadata -> $n`, values are bound as a `text[]` parameter, and nothing from the rule is spliced into SQL. It therefore applies before `LIMIT`, so the nearest or best facts inside the boundary come back even when nearer ones sit outside it. Row-Level Security is not used for it: the write path rebuilds a tenant's whole graph and must see every row of the tenant, so an RLS policy on the store's own role would break writes. A separate read-only role with its own RLS policy remains possible for reporting tools that query the table directly.

`validTo` invalidation updates the original row and records a version. Physical deletion occurs only through the explicit erasure API and removes dependent edges, versions, and embeddings. `storeAudit(store)` appends events in the same transaction as a governed mutation. Audit hashes are tenant-specific. A count and head on the tenant row detect accidental row or tail deletion before the next append. Anchor `auditHead()` outside the database if a database owner's deliberate rewrite must be detectable.

`verifyAudit({ head? })` checks one tenant's chain from an open store, in a read-only snapshot: every link, then the tenant row's count and head. It writes nothing, and a tenant with no row is reported rather than created. From the command line: `DATABASE_URL=... al-buddy-memory verify-audit --postgres --tenant <key>` (the HMAC key, if any, from `AL_BUDDY_MEMORY_AUDIT_KEY`).

[Erasure by label](ERASURE.md) (`eraseWhere`) works the same on Postgres as on SQLite — the parity test holds the receipts equal — and its receipt checks against the tenant's chain with `verifyErasureReceipt(receipt, store)` or `verify-audit --postgres --tenant <key> --receipt receipt.json`. Erased rows stay in the table's dead tuples until VACUUM, and in any backup or replica taken before; the receipt says so.

At-rest encryption is the database operator's responsibility: configure Aurora or Postgres storage encryption with KMS-managed keys, encrypted backups, and TLS connections. `encryptionKeyRef` remains immutable provenance metadata; this backend does not add column encryption.

`initialize()` creates the extension, tables, and indexes and must run before using a new database. It requires schema-creation privileges; grant the runtime role only the permissions it needs after migration. The current write path reconstructs one tenant's graph to apply the same domain rules as the in-memory store, then persists changed rows in one transaction. Its mutation cost grows with tenant size; benchmark representative tenant sizes before using it for high-write workloads.

The test suite uses in-process PGlite with its pgvector extension. No Docker or network service is required. `npm run check` runs the shared `MemoryStore` conformance suite against it.
