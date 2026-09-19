# What is enforced, what is a prompt, and what is still a person's decision

A policy is a claim about behaviour. This page is the honest ledger behind the claims in
this folder: for each rule, whether the store enforces it in code, whether it is carried by
an assistant's prompt (which a caller can ignore), or whether it is still a human decision.
The governing principle, from the original corpus: **a false escalation costs less than a
false claim of authority.** Every gate below fails in that direction on purpose.

Nothing here says the system is safe. It says exactly what is enforced, and it changes in the
open — with a test wherever one is possible.

## Enforced in code (this library)

| Rule | Where | What happens |
|---|---|---|
| A fact that stops being true is closed with `validTo`, never overwritten | every `MemoryStore` | `updateNode` closes validity and keeps the record; raw `content` cannot be changed, so a correction is a new fact |
| Erasure is the one destructive operation, and it is governed | `src/governance/governed-store.ts` | `deleteNode`/`deleteEdge` on a governed handle run `beforeErase`; refused unless some policy returns `true` and none refuses; every attempt audited with purpose `erase`. The raw store can erase — which is why the raw store is not what you hand out |
| Who asserted a fact, what it said, when, and its key reference never change after write | `src/immutable.ts` (both stores) | a patch to `provenance`, `nodeId`, `encryptionKeyRef`, `content` or the anchor trail throws; `restoreNode` over an existing fact refuses any of those and any rewritten or shortened anchor trail |
| One spelling per instant | `src/instant.ts` (both stores) | timestamps are canonicalised to UTC on the way in; a date alone means midnight UTC; a date-time without a zone, an impossible calendar date (2026-02-30) or junk is refused. Stores written before 0.4.0 have their validity bounds rewritten on open; anchors are compared as instants |
| Sealed facts never surface unless asked for by classification | `src/sqlite-memory-store.ts`, `src/in-memory-store.ts` | excluded from every search that does not name `Sealed` |
| Archived and pending-deletion facts stay out of active context | the stores | excluded from search unless named by tier |
| A policy may refuse a write, refuse a change, hide a fact from an audience, or stop it leaving in an export | `src/governance/governed-store.ts` | `govern()` runs `beforeWrite` (also on import), `beforeUpdate` (also when an import overwrites), `beforeRead` (also on `listNodes` and `getEdges`), `beforeExport`, `beforeErase`; a fact an actor cannot read is "not found" to their updates, erasures, links and embedding calls — failing exactly as a missing fact does; links cannot be rewritten by re-importing them; refusals throw `PolicyDenied` |
| Every governed decision is recorded — when an audit sink is supplied | `src/governance/audit.ts`, `src/governance/audit-table.ts` | append-only events (allowed, hidden, denied), hash-chained (HMAC with a key): an edited, removed, inserted or reordered record is named by `al-buddy-memory verify-audit`. A cut-off tail, or a rewrite by whoever holds the key, is caught only against a head hash anchored elsewhere — that has not changed and will not. The embedding cache follows the facts' visibility but is not audited (vectors are derived and never returned as facts) |
| **Where** the trail goes decides whether a commit can outlive its event | `storeAudit(store)` vs `ChainedAudit` | `storeAudit(store)` writes into the store's own `audit_events` table, **inside the mutation's transaction** — the fact and the event land together or neither does, and many processes share one chain because the tail is read and extended under the same write lock. That is the MCP server's default since 2026-09-19, and it needs a store implementing the optional `AuditCapable` capability. Any sink beside the database writes the event **after** the store call succeeds, so a sink that fails leaves **that one** committed write without its event and the call rejects. "That one" is a bound, and the queue below is what makes it one — while `addNode` was off the queue, twenty concurrent adds all cleared the latch before the first failure was observed and all twenty landed (corrected 2026-09-19). Tests: `src/governance/audit-table.test.ts` asserts **zero** facts survive a failed append on the table path; `src/governance/audit-poison.test.ts` asserts **one** on the JSONL path |
| A store whose audit sink has failed stops changing | `src/governance/governed-store.ts` | the failure is latched on the sink, so every governed handle sharing it refuses the next write, update, erasure, link or import **before** touching the store, until the process restarts. Every mutation queues, so "the next one" includes the ones already in flight. This does not close the window above — it stops that window being reopened by a retrying client, which is what used to happen (R3, release review 2026-09-18; `src/governance/audit-poison.test.ts`). The `audit_events` path deliberately does **not** latch: there is no unrecorded write to protect, because a failed append rolled the fact back with it, and latching would brick a store that lost nothing |
| Authorisation and the mutation it authorises are one step | `src/governance/governed-store.ts` | governed mutations over one store are serialised, so a policy decision cannot be committed against a row another handle changed while the (async) policies ran. **Who** is asking is fixed when the call is made, not when the queue reaches it — between the fix that added the queue (2026-09-18) and 2026-09-19 it was the latter, so a stranger's mutation overtaken by the owner's request ran, and was audited, as the owner. One process only: two processes on one file have SQLite's write lock, which covers the write and not the decision (`src/governance/governed-race.test.ts`) |
| One project's facts are one project's | `src/project-memory.ts`, `src/sqlite-memory-store.ts` | the filename carries a digest of the whole scope in a namespace the old filenames cannot reach (`<stub>.<digest>.db`; the stub never holds a dot), and the scope is recorded inside the database by a conditional insert in one `BEGIN IMMEDIATE` transaction, so two processes claiming one unstamped file cannot both win; opening a store under a different scope throws. Until 0.4.2 every character outside `[a-zA-Z0-9_-]` became `-`, so `org/repo` and `org-repo` shared one file and each recalled the other's private facts (R1, release review 2026-09-18; `src/project-memory-isolation.test.ts`, `src/scope-claim-race.test.ts`) |
| Secrets written as ordinary facts become Sensitive; Sensitive and Sealed never reach another audience, leave, or get erased without the owner acting in person; only the owner's actor changes a fact | `personalDefaults` | see `src/governance/samples.ts` |
| A governed read's page is the first facts the actor may see, in an order hidden facts cannot influence | `src/governance/governed-store.ts` | hidden facts never take a place on a limited page, a cursor the actor cannot see behaves as a missing one, and keyword results are ranked by word rarity over the visible matches only, not whole-store BM25 statistics |
| Confidence is a weight in [0,1]; decay a rate ≥ 0 | `src/instant.ts` (both stores) | refused on every write path |
| A guardian's facts can only be written, changed or retired by a guardian | `guardianMode` | `src/governance/samples.ts` |
| Low-confidence inferences are hidden from non-reviewers; exports gated to exporters | `enterpriseAudit` | `src/governance/samples.ts` |
| Derived facts cite their sources and never rewrite raw text | `src/consolidation.ts` | a derived fact without a known source is refused; raw nodes get an anchor, not an edit. It is written **retracted** and stands only once every evidence edge is recorded, so a pass that dies part-way — including because the audit sink died and the store now refuses changes — leaves a withdrawn conclusion, never an unsupported one (`src/consolidation.test.ts`) |
| The export leaves the vendor intact | `src/memory-portability.ts`, `docs/portable-format.schema.json` | every node (any tier, any classification) and every edge between exported nodes; tested through both stores; a real export validates against the published schema. Embeddings are not exported — they are a cache, rebuilt on import. The conformance *score* proves an artifact round-trips; it cannot see what an export left out |
| The MCP server is governed | `bin/al-buddy-memory-mcp.js`, `serverStore` | the owner's `personalDefaults` with the AI client as audience: secrets it writes become Sensitive and stay out of AI recall; every call audited, by default into the database's own `audit_events` table (`AL_BUDDY_MEMORY_AUDIT` names a JSONL file instead, and then only one process may write it) |

## Carried by a prompt (an assistant honours it; the store cannot make it)

- Never a yes-person: disagree in the first line with the reason, recommend, defer once the person decides.
- Intellectual humility: signal uncertainty, present perspectives on contested topics, accept correction, do not re-argue a rejected point.
- Anti-manipulation: no engagement optimisation, no manufactured urgency, no shame, no dependency framing.
- Lifecycle calibration of tone, content and authority.
- Escalation ceiling: no substitute for medical, legal, psychological or financial professionals.

The starter in [docs/STARTER.md](../STARTER.md) pins these as facts at the top of every prompt so they are at least always present. A caller can still ignore them; that is what "prompt" means.

## Still a person's decision (not enforced by this library)

- Anything consequential an assistant might do with the memory: spending money, deleting an account, posting publicly, connecting a new service, handling credentials, signing anything. The library holds facts; the application must gate the actions.
- Encryption at rest. `encryptionKeyRef` names the key you manage; the store does not encrypt the file. Put it on an encrypted volume.
- Consent ledgers, deletion workflows for a whole account, multi-tenant isolation, guardian-to-user handoff at maturity: described in the policies, not shipped here.
- Changing any policy or boundary. A system that can quietly widen its own authority has none.

## Decided autonomously

Everything not above. A registry that tries to enumerate permitted actions goes stale and turns into a permission queue nobody reads. The list of things needing a person is short, and short is what makes it credible. Reasoning gets recorded — in memory, in a commit, in an audit event — so a decision can be reviewed after the fact even when it did not need asking first.
