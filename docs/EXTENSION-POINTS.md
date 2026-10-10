# Extension points

Four places where code outside this package can take part without forking it: one under the
Postgres store, one beside it, one under `govern()`, and one in a policy. Each is optional.
Leave one out and the store behaves exactly as it did before it existed:
`src/extension-points.test.ts` holds the defaults to the same statements, results and queue,
and runs the conformance suites through the new paths.

## `QueryExecutor`: where the Postgres store's statements go

```ts
interface QueryExecutor {
  query(sql: string, values?: unknown[]): Promise<{ rows: any[] }>;
  transaction<T>(work: (db: PostgresQueryClient) => Promise<T>): Promise<T>;
}

new PostgresMemoryStore({ tenantId, executor });
```

`PostgresMemoryStore` runs every statement through its executor: `initialize()`'s setup with
`query`, and everything else in a `transaction`, whose callback gets the client for the statements
inside it. Without one it uses the `client` you pass (PGlite's own `transaction`), or a
node-postgres pool made from `connectionString` and driven by `poolExecutor(pool)`: one
connection per transaction, `BEGIN` … `COMMIT`, `ROLLBACK` if the work throws, released either
way. The SQL does not change with the executor. An executor decides where it is sent and what
happens around each transaction, and can wrap `poolExecutor` to add to the default rather than
replace it.

## `StoreAuditSink`: hearing every access to a tenant

```ts
new PostgresMemoryStore({ tenantId, client, accessAudit: { sink, reads: true } });
// sink.record({ at, tenantId, access: "read" | "write", operation, ids }, db)
```

Off by default. With a sink, every call that changes the tenant's memory is heard (`addNode`,
`updateNode`, `deleteNode`, the restores, edges, embeddings), and with `reads: true` every call
that reads it as well (`getNode`, `listNodes`, `searchNodes`, `searchSimilar`, the snapshots,
history, edges, embeddings, `nodesRestingOn`). `operation` is the method name. `ids` are the ids
the call named (for `addNode` and `addEdge`, the one it minted) and, for a read, every fact, link
and version it returned.

`record` runs inside the call's own transaction, after the work and before the commit, and is
given that transaction's client. A row it writes on `db` commits with the call or not at all, and
a sink that throws rolls the call back, so a sink that cannot record stops the access instead of
missing it. A call that fails is not heard. With `reads` off, a read costs exactly what it did.

This is not the governance trail. `govern(store, { audit })` records decisions (who was allowed
or refused what, by which policy). This records access to the store, governed or not.

## `LockProvider`: what holds a decision and its write together

```ts
interface LockProvider {
  withLock<T>(store: MemoryStore, step: () => Promise<T>): Promise<T>;
}

govern(inner, { policies, context, lock });
```

Every governed mutation runs its policy checks and its write as one `withLock(inner, step)`,
`inner` being the store passed to `govern`, so every handle over one store shares the lock.
Reads do not take it. The default, `inProcessLock`, is the queue described in
[GOVERNANCE.md](GOVERNANCE.md#what-one-process-guarantees-and-what-it-does-not), so it covers one
process. A provider must run `step` once, with no other step for the same store running, release
the lock however `step` settles, and settle as `step` did. One that also excludes other processes
must still exclude within its own: wrapping `inProcessLock` does that. Under any lock, a policy
hook that mutates through a handle over the same store waits for itself.

## `readBoundary`: who sees what, as data

The boundary hook already exists: a policy's `readBoundary` declares a read rule over fact labels
and the actor's attributes, and SQLite and Postgres run it inside their own query. See
[policies/boundaries.md](policies/boundaries.md).
