# Security review of the enterprise surface, 2026-10

Scope: the five enterprise jobs, as merged on 2026-10-08. They are the Postgres store
(`src/postgres-memory-store.ts`), data boundaries compiled into SQL (`readBoundary`, `labels`),
erasure by label with receipts (`eraseWhere`, `verifyErasureReceipt`), incremental Postgres
writes, and OIDC sign-in for the HTTP server (`src/mcp/oidc.ts`, `src/mcp/http-server.ts`). The
review read the code and probed it with tests on SQLite, Postgres (PGlite, in process) and the
in-memory store. Every finding has a test that failed before its fix:
`src/governance/security-review-2026-10.test.ts` and `src/mcp/oidc.test.ts`.

## Found and fixed

| # | Severity | Finding | Fix |
|---|---|---|---|
| 1 | Medium | **A filter could probe a redacted label.** A governed `searchNodes` with `labels` or `tags` was matched against the stored labels, so for a fact whose label a `beforeRead` policy strips, getting the fact back confirmed the stripped value (`labels: { label: "rate", in: ["120"] }`). `eraseWhere` selected and counted on the same stored labels, so its `matched` count answered the same question. This is the label form of the redacted-word leak fixed in keyword search the day before. | A caller's `labels` and `tags` must also hold on the fact as the actor sees it, on every search path (keyword, paged, unpaged) and in `eraseWhere`'s selection. Facts the policies pass unchanged match exactly as before. The receipt's `outside` text says so. |
| 2 | Low | **A refusal named a fact the actor cannot see.** An erase (or invalidation) refused because of a conclusion drawn from the fact answered with that conclusion's id and the policy's reason about it, even when the conclusion was outside the actor's boundary (for example "under legal hold matter-…"). `eraseWhere` copied that reason into the receipt, with the ids hashed but the reason text intact. | When the actor cannot see the conclusion, the refusal says only that "a fact concluded from it, which this actor cannot see, may not be erased". An actor who can see it is still told which fact and why. |
| 3 | Medium | **Signing keys could be fetched over plain http.** `issuer` (discovery), `jwksUri` and the discovered `jwks_uri` accepted any http URL, and whoever answers that fetch decides which signatures verify. | They must be https, except for `localhost`, `127.x` or `[::1]` (development and tests). A given `jwks` fetches nothing and is unaffected. |
| 4 | Low | **`clockToleranceSeconds` was unbounded.** `Infinity`, `NaN` or a very large value turned the `exp` and `nbf` checks off. | It must be a number from 0 to 300. |
| 5 | Medium (docs) | **The sign-in example served any tenant.** `docs/SIGN-IN.md` opened a store for whatever tenant claim arrived. With an issuer that signs for many organisations (Google's, where `hd` is any Workspace domain), any organisation could sign in and get its own memory on the operator's database. | The example refuses tenants the server does not serve, and the page says that the tenant claim picks a store but does not decide who may sign in. It also says to name the actor by an identifier the person cannot change (`sub`, `oid`, `uid`, not `email` or `upn`). |

## Checked and held

These are guarded by the new tests unless a test is named.

- **SQL injection.** Every label, value, tag, tenant id, model name, instant and query reaches
  Postgres and SQLite as a bound parameter. The only text spliced into SQL is fixed strings, the
  validated `indexedDimensions` integer, and tsquery lexemes built from letters and digits only. A
  label, value, tag, tenant id and query made of quotes, `;`, `--`, `?|` and `$1` are matched as
  data.
- **Cross-tenant reads and writes (Postgres).** Every statement filters on `tenant_key`,
  including the similarity join, the dependents walk and the embedding cleanup. A second tenant
  cannot read another tenant's facts, links, versions or vectors, or change them by
  `updateNode`, `deleteNode`, `addEdge`, `restoreEdge`, `deleteEdge`, `setEmbedding`,
  `deleteEmbeddings`, `restoreVersion`, or by a conclusion naming the other tenant's ids.
- **The boundary on every read path.** `getNode`, `listNodes`, `getEdges` (an edge to a hidden
  fact is dropped), embeddings, history and as-of reads, export and `historySnapshot` all apply
  the boundary before the hooks. Keyword ranking uses only the visible matches, a paged search
  fills its page with visible facts only, and a hidden cursor answers like a missing one
  (`boundary.test.ts`, `boundary-parity.test.ts`, `cursor-oracle.test.ts`; history and as-of reads
  in the new tests). The SQL compilation and
  `matchesLabels` agree on strings, arrays, other JSON types and missing labels, so the store never
  admits a fact that the governed handle's own check would drop.
- **Erasure copies.** After `eraseWhere` (and `deleteNode`), no row in any live table holds the
  erased fact's or its conclusion's id or text: facts, versions, edges, vectors, and the keyword
  index (SQLite's FTS row, Postgres's generated tsvector). The audit trail keeps ids, never
  content, as the receipt states. Recently deleted keeps content until a purge, by design.
- **Receipts.** The digest covers every field. Verification needs exactly one event in a
  verifying chain with that digest and the receipt's actor, time and count. No governed call can
  write an event carrying a `receipt` field, apart from `eraseWhere` itself.
- **JWT.** The checks are jose's: signature against the configured keys, `iss` exact, `aud`, and
  `exp` required. Algorithms are asymmetric only, so `none` and HS-with-the-public-key are refused.
  A discovery document must name the configured issuer. Claims are read only from the verified
  payload, and a missing actor or tenant claim is refused (`oidc.test.ts`, `http-oidc.test.ts`).

## Not covered, or left as it is

- **No Postgres row-level security.** Tenant isolation is in the library's queries. A database
  role that can reach `memory_items` can read every tenant. Use one role per deployment and the
  database's own controls. RLS policies keyed on `tenant_key` would be defence in depth.
- **Decisions across processes.** The governed queue serialises one process. Two processes on
  one Postgres tenant can judge an erase's conclusions outside the tenant lock, so a conclusion
  added in that moment goes with its source unjudged. This is the limit documented in
  `docs/policies/ENFORCEMENT.md`.
- **`deleteEdge` takes only an id.** The store interface has no edge lookup, so the governed
  handle cannot check the endpoints' visibility. Edge ids are random unless an import chose them.
  It still runs the erase policies.
- **`restoreNode` over a hidden id is refused, and over a missing one it creates the fact.** An
  importer can tell those two cases apart. This is inherent to imports that choose their own ids.
- **Source ids are visible by design.** A conclusion's `derivedFrom` and a fact's `supersededBy`
  name other facts' ids, visible or not. Receipt id hashes are unsalted, so an id chosen by an
  import (not a random UUID) can be confirmed by anyone who guesses it.
- **Only label and tag filters are checked against the redacted view.** A policy that rewrites
  `memoryType`, `confidenceWeight`, validity, tier or classification on read is still filtered on
  the stored values.
- **OIDC, not covered:** token revocation and replay (a valid token is honoured until `exp`),
  required scopes (none are required), the `typ` header, redirects during key fetches (followed
  as `fetch` and jose follow them), and claims the provider lets users edit. The HTTP server was
  run in process only, never behind a real proxy or identity provider.
- **Not run here:** the child-process and cross-process SQLite tests (this sandbox cannot load
  the native `better-sqlite3`; the suite ran on a `node:sqlite` shim), Postgres beyond PGlite,
  timing side channels, denial of service, and dependencies (see the 2026-10-07 sweep).
