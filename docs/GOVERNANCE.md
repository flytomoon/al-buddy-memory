# Governance: enforcing the vocabulary

The store ships the words — `privacyClassification` (Public / Private / Sensitive /
Sealed), `retentionTier`, `provenance` on every fact and relation. `govern()` is what
enforces them.

```ts
import { SqliteMemoryStore, govern, personalDefaults, JsonlAudit } from "al-buddy-memory";

const store = govern(new SqliteMemoryStore("brain.db"), {
  policies: [personalDefaults({ owner: "chris" })],
  context: () => ({ actor: currentActor() }),      // who is acting right now
  audit: new JsonlAudit("~/.al-buddy-memory/audit.jsonl"),
});
```

A policy is a plain object with up to five hooks:

| Hook | Runs | Can |
|---|---|---|
| `beforeWrite(node, ctx)` | before a fact is stored, and on import (`restoreNode`) | transform it (classify, tag) or refuse it |
| `beforeUpdate(existing, patch, ctx)` | before a change or invalidation, and when an import overwrites a fact | refuse it |
| `beforeRead(node, ctx)` | on the way out of `getNode`, `searchNodes`, `listNodes`, and for the endpoints of `getEdges` and the facts behind embeddings | hide it (`null`) or redact it |
| `beforeExport(node, ctx)` | when an `exportView` is being exported | allow or refuse |
| `beforeErase(subject, ctx)` | before `deleteNode` / `deleteEdge` | return `true` to allow, throw to refuse, return nothing to abstain; erasure needs one allow and no refusal |

`ctx` carries `actor`, optional `audience`, `purpose` (write / recall / invalidate / export /
import / erase) and `now`. Policies compose in order. Refusals throw `PolicyDenied` with the
policy's name and reason. When an audit sink is supplied, every allow, hide and refusal lands
in it as an append-only event; embedding calls are not audited. **When** the event is written
depends on the sink, and it is the difference between two guarantees — see below.

### Where the trail goes, and what that decides

There are two places to put it.

**In the database (`storeAudit(store)` — the MCP server's default since 2026-09-19).** Events go into
the store's own `audit_events` table, appended inside the mutation's own `BEGIN IMMEDIATE`
transaction. Three consequences, and only three. The fact and its event land together or
neither does, so no commit can outlive its event. There is one chain however many processes
write to it, because the tail is read and extended under the same write lock — no directory
of files, no manifest to forge, nothing to fork, and a record cut from the middle breaks the
link at the record after it. And the chain is inside the file, so a restored backup carries
a self-consistent chain of its own, which disagrees with any head anchored elsewhere. It
needs a store that implements the optional `AuditCapable` capability; `SqliteMemoryStore`
does.

What it costs, measured on an M1 Pro: +0.04 ms per governed write and +0.5 ms per governed
read. A read is audited too, so with this sink a read briefly takes the database's write
lock — worth knowing if two processes are reading hard. Extending the chain re-verifies it
once per store object, which is 77 ms at 20,000 events, paid on the first write.

**Beside the database (`ChainedAudit`, `JsonlAudit`).** For a store that cannot do the
above, and for anyone who wants the trail outside the file it describes. The event is
written **after** the store call succeeds, which leaves the window described under "fails
closed" below, and one chain has one writer, which is why the MCP server used to give each
process its own file.

Switching from files to the table does not migrate anything: the table starts empty and the
existing logs are neither adopted nor extended. They cover a period the table cannot attest
to and it covers one they cannot, so `al-buddy-memory verify-audit <db>` reports both.

### A log you can check

`JsonlAudit` appends events; `ChainedAudit` also chains them. Each line carries the hash of
the line before and of its own event (HMAC-SHA256 when you pass a `key`), so
`verifyAuditChain(path, { key })` — or `al-buddy-memory verify-audit <file>` with the key in
`AL_BUDDY_MEMORY_AUDIT_KEY` — names the first line that was edited, removed, inserted or
reordered. Two limits, stated rather than implied: a file cannot prove its tail was not cut
off, and whoever holds the key can rewrite the whole chain. Both are caught by anchoring:
publish `await audit.head()` somewhere the log's owner does not control (a git commit, a
transparency log) and verify with `{ head }`. One writer per file, and one key per log: the
chain proves a log is internally intact, not which log it is, so two logs under the same key
can be swapped for each other undetected unless their heads are anchored. On start the log is
verified in full under its key and must end with a complete line; after an append fails
part-way, nothing more is written until it has been checked and the process restarted — the
audit fails closed. Without a key — the MCP
server's default — the chain catches accidental damage and careless edits, not a deliberate
rewrite: anyone who can write the file can recompute the whole chain. A line whose last entry
is incomplete (a crash mid-append) stops the log from being extended until that line is
removed; the MCP server refuses to start rather than write unaudited.

**What "fails closed" does and does not mean — on a sink beside the database.** After such
a sink fails, the governed store stops changing anything: the next write, update, erasure,
link or import is refused before it reaches the store, for every handle sharing that sink,
until the process restarts. What it cannot undo is the write already committed — a mutation
commits and *then* its event is written, so the one write that broke the sink is itself
unrecorded and its caller is told it failed. That window is the honest limit and it is in
[docs/policies/ENFORCEMENT.md](policies/ENFORCEMENT.md). Until 0.4.2 everything *after* that
window went through as well, so a retrying MCP client compounded changes nothing could
attest to (R3, release review 2026-09-18).

On the `audit_events` path there is no such window, and so no latch: an append that fails
rolls the fact back with it, the caller is told, and nothing was lost — so the store is left
working rather than bricked by a transient failure. That is the failure the latch bounds
becoming unreachable, not the latch being weakened; it still guards every sink that writes
beside the database.

### What verification establishes

`al-buddy-memory verify-audit` — over a database's `audit_events`, a JSONL file, or a
directory of them — establishes that every record follows the one before it and has not been
edited, removed, inserted or reordered, under the key it is given if the chain has one. Over
a database it establishes one thing more: because each event was appended in the same
transaction as the fact, **no mutation made through a governed handle writing to this table
committed without an event**.

Read that clause exactly as written. It is not "every change to this database is recorded":
a holder of the *raw* store mutates with no event at all, which is what "the raw store is
not governed by anything" has always meant, and a handle configured with a different sink
records somewhere else. The table attests to what went through it.

It does not establish that the trail is complete. Records cut from the END leave a chain
that verifies, so no trail can prove its own tail; only a head hash anchored somewhere the
owner does not control catches that. It is tamper-**evident**, not tamper-proof: whoever
holds the HMAC key — or, with no key, anyone who can write the file — can recompute the
whole chain, and a restored backup carries a self-consistent chain of its own. What
distinguishes a rewrite or a restored backup from the real history is the anchored head
disagreeing with it, and nothing else. And it says nothing about whether a policy *decision*
was still true when the write landed: that is authorisation across processes, and it is
open (`docs/RESILIENCE-LEDGER.md`, section C).

**One writer per log, not one writer per memory.** A chain in a *file* has exactly one
writer, but a person legitimately runs two assistants against one memory. Before the table the
MCP server resolved that by giving each process its own log —
`<db>.audit/<start>-<pid>.jsonl` — and `al-buddy-memory verify-audit <db>.audit` checks
every chain in such a directory. The `audit_events` table resolves it the other way, and
better: one chain, many writers, because the tail is read and extended under SQLite's write
lock. Two real processes proving it: `src/governance/audit-cross-process.test.ts`.

**What that verification does and does not establish, for a directory of files.** It proves
each log that is *present* is internally intact. It cannot prove the set is *complete*:
there is no manifest and no cross-chain binding, so deleting an entire process log leaves
the rest verifying clean and the command exits 0 — confirmed by experiment (Astra release
review, 2026-09-19). Splitting the chain to let two assistants share a memory bought that
concurrency at this cost. One table does not have that cost, which is why it is the default
now; a directory of files still does, and existing directories are still checked on those
terms. Two processes appending to one file fork the chain at the first
interleaved pair, and then no server can start, because refusing to extend a broken chain is
what this class does (B1, release review 2026-09-18). A lock file was considered and
rejected: making the second assistant fail to start is worse than two verifiable logs. A log
written by 0.4.1 or earlier sits at `<db>.audit.jsonl` and is not extended; check it on its
own with `al-buddy-memory verify-audit <db>.audit.jsonl`. Setting `AL_BUDDY_MEMORY_AUDIT`
pins one file, and then it is on you to run one server against it.

### What one process guarantees, and what it does not

Authorisation and the mutation it authorises run as one step: while a governed mutation is
between its policy checks and its commit, no other governed handle over the same store can
commit. Without that, an agent's allowed update landed after the owner had made a fact
Sensitive and left it Private and readable (R2, release review 2026-09-18) — the policies
are async by design, and every await was a window.

**Who is fixed when you call, not when the queue reaches you.** The authorising context is
read at the moment the mutation is requested; only the clock is read when the queued step
runs. The first version of the queue read both at execution time, so a mutation waiting its
turn could pick up whatever authority the caller's context reported by then — a write called
as a stranger committed and audited as the owner, which the pre-queue code had refused
(Astra release review, 2026-09-19). Freezing the clock too would have been the opposite
mistake: every audit event behind a slow policy would carry a backdated time.

The queue is per store object, in **one process**. Two processes on one SQLite file are
still protected only by SQLite's own write lock, which covers the write and not the
decision that preceded it; a cross-process guarantee needs the check and the write in one
database transaction, and that is not built. Moving the audit trail into the database
(2026-09-19) did **not** change this. It made the interleaving legible — two processes' events
are one ordered chain now rather than two files that cannot be ordered against each other —
and legible is not prevented. One consequence to know about: a policy hook
must not call a mutating method on a governed store over the same inner store — it would be
waiting for the queue it is already holding.

Hidden facts cannot change what a governed read returns or in what order. A governed keyword
search reads every match, keeps the visible ones and ranks them by word rarity counted over
those visible matches alone, then confidence, then recency — not by the store's BM25, whose
word weights come from all facts, hidden ones included, and so let a hidden fact reorder
visible results. Ranking uses the text the actor sees; but which facts match is decided from
the stored words, so a redacting `beforeRead` still lets a search for a redacted word find
the fact — and a redacted match still counts toward the word weights, so it can move the
order of other results. To keep content out of search, hide the fact; do not merely redact it. One side channel
remains and is inherent: a governed read that steps past many hidden facts takes longer. It
never shows a hidden fact or its text. Where even a timing hint is unacceptable, give that
audience a separate store.

### What no hook governs yet

- **Links.** `addEdge` and `restoreEdge` check that the actor can see both facts, and nothing
  more: there is no `beforeLink`, so a policy cannot yet say who may assert that two facts
  contradict each other, and an edge's provenance and `createdAt` are what the writer says.
- **Mutable state brought by an import.** `restoreNode` over an existing fact may change its
  confidence, tiers or validity without appending an anchor of its own; on a governed handle
  the import is audited, on the raw store nothing records it.

A fact the actor cannot read is "not found" to their updates, erasures, links and embedding
calls, failing exactly as a missing fact does. Two edges of that rule, stated so nobody has to
find them: importing over a hidden fact is refused with `PolicyDenied` (so an actor who can
import and holds a candidate id learns that it exists), and `deleteEdge` is judged by the
erase policies alone, because an edge id carries no endpoints to check.

## The three samples

- **personalDefaults({ owner })** — the owner sees everything; anything that looks like a
  secret (API tokens, card numbers, "password: …", private keys) is written as Sensitive;
  Sensitive and Sealed facts never reach another audience, never leave in an export and are
  never erased unless the owner is acting in person (actor = owner, no other audience); only
  the owner's actor may change a fact. It assumes the owner is the actor and an assistant
  working for them is a different audience — which is how the MCP server is wired.
- **guardianMode({ guardians })** — only a guardian may write, change or invalidate a
  `GuardianAdded` fact. Everyone may read them; that is what they are for.
- **enterpriseAudit({ reviewers, exporters, minInferredConfidence })** — AI-inferred facts
  below the confidence floor are hidden from everyone but reviewers; nothing leaves in an
  export unless the actor is an exporter. The audit trail does the rest.

Copy one, rename it, change the rule. Governance should read like a rule a person can
check, not a framework.

## What the store guarantees without any policy

- Sealed facts never surface unless asked for by classification.
- `nodeId`, `provenance`, `encryptionKeyRef`, raw `content` and the temporal-anchor trail are
  immutable after write, including through `restoreNode`; an attempt to change them throws.
- Invalidation closes `validTo` and keeps the record. Erasure exists — stewardship law needs
  it — but on a governed handle it runs `beforeErase` and is refused unless a policy allows it.

## The governed handle is the boundary

`govern()` is a capability, not a firewall around the process: it governs whoever calls
through it. Give applications, agents and MCP clients the governed handle; keep the inner store
where only the operator can reach it. Provenance is what the writer asserts — immutable once
written, not verified; if agents must never write `UserInput`, say so in a `beforeWrite`.
