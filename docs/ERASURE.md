# Erasure by label, with a receipt

A request to erase everything held about someone — a data subject under GDPR Article 17, a
customer leaving, a matter closed — is a request about a *label*, not a list of ids. If your
facts carry labels (the keys of `contextualMetadata`, the same ones a
[data boundary](policies/boundaries.md) reads), the governed handle can answer it:

```ts
import { SqliteMemoryStore, govern, storeAudit, verifyErasureReceipt } from "al-buddy-memory";

const inner = new SqliteMemoryStore("memory.db"); // or PostgresMemoryStore
const store = govern(inner, { policies, context, audit: storeAudit(inner) });

const receipt = await store.eraseWhere({ label: "subject", equals: "person-42" });
// Keep it, hand it over, file it with the request.

const check = await verifyErasureReceipt(receipt, "memory.db"); // or the open store
```

From the command line, against the same trail `verify-audit` checks:

```sh
al-buddy-memory verify-audit memory.db --receipt receipt.json
DATABASE_URL=... al-buddy-memory verify-audit --postgres --tenant <key> --receipt receipt.json
```

## What it does

1. **Finds** every fact whose labels match the selector — in every tier and classification,
   archived and sealed facts included — that the erasing actor can see.
2. **Asks the erase policies about each one**, exactly as `deleteNode` does, through the same
   code: the fact and every conclusion built on it are judged as one decision. A
   `memoryLock()` refuses all of them; a policy that protects some facts refuses those. A
   refusal leaves that fact (and its conclusions) where it is, and is recorded with the
   policy's name and reason; the rest go ahead.
3. **Erases what was allowed, with everything concluded from it** — history, links and
   embeddings go with each fact. On a handle with `recentlyDeleted`, allowed facts move to
   Recently deleted instead, with their conclusions, and become final only when `purgeDeleted`
   runs after the days are up (asking the policies again). The receipt says so, with the date
   each becomes final.
4. **Writes the receipt** and records its digest in the audit trail, as one event with
   `purpose: "erase"` and a `receipt` field. Each erasure also has its own event, as
   `deleteNode`'s does, whose reason names the receipt's id.

## The receipt

| Field | Holds |
|---|---|
| `selector`, `actor`, `audience`, `at` | what was asked for, by whom, when (the `at` of the attesting event) |
| `matched` | facts carrying the labels that the actor could see |
| `erased` | `count`, of which `matched` were selected and `concluded` were built on them; `ids` |
| `refused` | `count`, and per fact its id, the refusing policy and its reason |
| `heldInRecentlyDeleted` | `count`, and per fact its id and `finalAfter` |
| `outside` | what the receipt does not reach, in words (below) |
| `digest` | sha256 of the canonical JSON of every other field |

Every id is hashed: `sha256("al-buddy-memory/fact-id\n" + id)`, hex (`erasedIdHash`). The
receipt never holds an id or any content in the clear, ids inside a policy's reason included,
so it can be handed to the person who asked. Whoever holds an id — a backup, an old export, a
log — can hash it and see whether that fact was covered. An id chosen to be guessable can be
confirmed by hashing a guess; the store's own ids are random.

## Checking it

`verifyErasureReceipt(receipt, trail)` — and `verify-audit --receipt` — passes only when:

- the receipt's digest matches its content (an edited receipt fails), and
- the trail verifies as a chain (see [GOVERNANCE.md](GOVERNANCE.md#what-verification-establishes)), and
- exactly one event in it carries that digest, for the same actor, time and count.

`trail` is anything `verify-audit` reads — a database file, a JSONL log, a directory of
them — with `key` for an HMAC-chained trail, or an open `SqliteMemoryStore` or
`PostgresMemoryStore`, which checks its own chain with its own key. `head` pins the chain to a
value you anchored elsewhere.

What a pass establishes is what the chain establishes: this receipt was recorded in this trail,
and neither has been changed since. Tamper-*evident*, not tamper-proof — whoever holds the key
can rewrite both; an anchored head is the answer to that, as it is for the rest of the trail.

## What it does not reach

The receipt says this itself, in `outside`, so it cannot be read as more than it is:

- **Backups and copies of the database** made before the erasure still hold the facts until
  they are deleted or expire. Erase or expire them separately; a restored backup brings them
  back (and an older audit chain with it, which disagrees with any head anchored since).
- **Exports made before the erasure** — `al-buddy-memory export`, `exportPortable`, anything a
  reader copied out — are outside it.
- **Facts the actor cannot see** are not selected, and not counted. Counting them would tell
  the actor they exist, which every other governed call refuses to do; so run a subject erasure
  as an actor whose policies let it see everything with those labels. (A conclusion drawn from a
  selected fact is different: it goes with the fact, as it does with `deleteNode`, after the
  erase policies have been asked about it, and the receipt counts it.) **Facts that do not carry
  the labels** are not matched: label facts when they are written.
- **Storage not yet reclaimed.** SQLite keeps deleted rows in free pages and the WAL until
  `compact()` (VACUUM) and a checkpoint; Postgres keeps dead rows until VACUUM.
- **The audit trail** keeps the events that name the erased facts' ids (never their content):
  pruning it would break the chain that makes the receipt checkable.
- **The raw store.** Whoever holds the inner store, or the database itself, is outside every
  policy, here as everywhere.

## Edges, stated

- It needs an audit sink. Without one there is nothing to chain the receipt into, and it is
  refused before anything is read.
- The selector is the boundary language with literal values only: `{ label, equals }`,
  `{ label, in }`, `{ all }`, `{ any }`. An actor attribute (`{ actor: "…" }`) is refused — a
  receipt records what was asked for, not what it resolved to — and so is an empty `all` or
  `any`: there is no "erase everything" selector.
- It runs in the handle's queue, one fact after another; it is not one transaction. Each
  erasure lands with its own event. If it fails part-way (not a refusal: a store error), what
  was erased stays erased and recorded, no receipt is written, and running it again erases the
  rest under a new receipt.
- Cost: one read of every fact to select, then, per selected fact, the read `deleteNode` already
  makes to find what was concluded from it. Fine for a subject's handful of facts; for tens of
  thousands at once on a large store, expect it to take a while.
- An export view refuses it, as it refuses every write.
