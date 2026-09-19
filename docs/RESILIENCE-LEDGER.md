# Resilience ledger

A running record of **specific, dated, verifiable cases** about how this memory
system behaves under the failure modes people report — in papers, in other
products, and in our own bug reports.

It exists because of a standing instruction from the project owner, 2026-09-17:

> *"I want you to document when we find cases, like documentation that proves why
> our memory is better. I need you to document that because we're going to
> eventually put a paper together explaining why our memory is super resilient
> (we won't use the word 'the best') and why it fixes all the issues other people
> have found, including papers. That's what we're going to be doing. When they do
> find issues and ours has issues, we're going to end up fixing them so keep a
> record of things like that."*

## The rules this file lives by

1. **"Resilient", never "the best."** That word is not used here, and it will not
   be used in the paper. Claims are comparative only where a measurement or a
   citation supports them.
2. **Both columns get filled in.** A case where we *also* had the defect is worth
   more than one where we did not, because it is checkable and because the fix is
   the evidence. A ledger with only wins is marketing, and a reviewer will read it
   as such.
3. **Every entry is anchored.** A version, a commit, a test name, a file and line,
   or a benchmark number. "We handle this well" is not an entry.
4. **A claim that turns out to be untrue is corrected here, not deleted.** Same
   discipline the library itself applies to facts: invalidate, don't erase.
5. **Cite the source failure mode.** If it came from a paper, name the paper. If
   from another product or an outside bug report, say which.

## How to add an entry

Append to the right section, newest first, using this shape:

```
### <short name of the failure mode>
- **Reported by:** <paper / product / outside report>, <date>
- **The failure:** <what goes wrong, stated so someone can test for it>
- **Us:** withstands | shared it, fixed | shared it, open
- **Evidence:** <version, commit, test name, file:line, or measured number>
- **Notes:** <what a reviewer would push back on>
```

Do not add an entry you have not checked against the code. An unverified entry is
worse than no entry, because this file is meant to survive review.

---

## A. Failure modes we withstand by design

### Destructive summarisation — the original is lost
- **Reported by:** a recurring complaint against summarise-and-replace memory
  designs; it is the reason this project's first architectural non-negotiable
  exists.
- **The failure:** the system compresses history into a summary and discards the
  source, so any error in the summary is permanent and unfalsifiable. Nothing can
  be re-derived, and the user cannot appeal.
- **Us:** withstands. Raw text is the source of truth; consolidation derives new
  nodes without destroying the ones it came from.
- **Evidence:** `src/consolidation.ts` retracts by setting `validTo` and keeps the
  node (`consolidation.ts:194` records `retractedAt: n.validTo`);
  `src/consolidation.test.ts:132,138` assert the retracted fact keeps its
  timestamp and the derived node stays live with `validTo: null`. Invalidate costs
  0.5 ms at 100k facts (`bench/bench.mjs`, README "Limits, measured").
- **Notes:** the honest limit is storage growth — we trade disk for recoverability.
  69 MB at 100,000 facts, measured. A reviewer should ask what happens at 10M; we
  have not measured that.

### Tamper-evident history
- **Reported by:** provenance and governance critiques of agent memory (the
  Oracle agent-memory write-up, evaluated 2026-09-14, is the clearest recent one).
- **The failure:** an audit log that can be edited, truncated or reordered after
  the fact proves nothing about what the system actually did.
- **Us:** withstands, as of 0.4.0.
- **Evidence:** every governance event carries the hash of the previous one
  (HMAC-SHA256); `al-buddy-memory verify-audit` names the first edited, removed,
  inserted or reordered record. Two places to keep it: a JSONL file
  (`ChainedAudit`, 0.4.0) or the database's own `audit_events` table
  (`storeAudit`, 2026-09-19). CHANGELOG 0.4.0 and the unreleased audit-table entry.
- **Notes:** a rewrite by whoever holds the key is still possible — the chain is
  tamper-*evident*, not tamper-proof, and the paper must say so in those words.
  The audit table did **not** change this, and it must not be written as if it
  had. What
  changed is the *pairing* of a fact with its event and the number of chains,
  not how much trust either form can carry. A cut-off tail is still invisible to
  the trail itself; only an anchored head catches it.

---

## B. Failure modes we shared, and fixed

*These are the load-bearing entries. They show the system was tested against
reality rather than described.*

### A commit that could outlive its own audit event
- **Reported by:** ourselves at 0.4.0, and again by both 0.4.1 reviews as the
  half of R3 that the 0.4.2 latch does not close. Named by the Fable 5.1 review
  of 2026-09-19 as the one structural move worth making before release.
- **The failure:** a governed mutation committed, and *then* its event was
  written. A sink that failed at that instant left the fact in the database with
  nothing attesting to it, while the caller was told the operation had failed.
  The queue and the latch bounded it to one such write; nothing could remove it,
  because a file beside the database cannot join the database's transaction.
- **Us:** shared it, **fixed 2026-09-19 (unreleased) — for a store that keeps
  its trail inside its own database.** `audit_events` is appended inside the mutation's own
  `BEGIN IMMEDIATE`, so the fact and the event land together or neither does.
  `ChainedAudit` and `JsonlAudit` are unchanged and keep the old bound; they are
  still the answer for a store that cannot do this, and that path stays in
  section C.
- **Evidence:** `src/governance/audit-table.test.ts`, *leaves NO fact behind
  when the event cannot be written* — an append is made to fail and the store
  holds **zero** new facts afterwards, where `audit-poison.test.ts` asserts
  exactly one on the JSONL path, and still does. Code:
  `src/sqlite-memory-store.ts` `mutation()` (every mutating method runs through
  it, so none can be added without carrying an event),
  `src/governance/governed-store.ts` `commitAudited`,
  `src/governance/audit-table.ts`. Also
  `src/governance/audit-cross-process.test.ts`: two real processes, twenty
  facts each, released from a barrier so they interleave — one chain, one total
  order, no two records sharing a `prev`.
- **Notes:** three things this is **not**. It is not more trust: the chain is
  exactly as tamper-evident as before, a key holder can still rewrite it, and a
  cut tail is still only caught by an anchored head (section A). It is not a
  completeness proof: it proves that nothing which went through a governed
  handle using this table committed without an event, not that every change to
  the database did — a holder of the raw store still mutates with no event at
  all, which is what "the raw store is not governed by anything" means, and the
  period the table covers is not necessarily the whole history. And it is not a
  cross-process authorisation guarantee — see section C, *Governed serialisation
  is per process*, which this narrowed and did not close. The test that proves
  the two-process property had to be built twice: the first version spawned the
  children without a barrier, they never overlapped, and a deliberately
  sabotaged build (chain head cached per process — the exact defect) passed it.
  A concurrency test that has not been shown to fail on the defect is decoration.

### A queue that also deferred the question of who was asking
- **Reported by:** GPT-6-Astra, re-reviewing the merged 0.4.2 work, 2026-09-19.
  Two of its three blockers were defects we had introduced the day before while
  fixing something else; this is the first, and the worse one.
- **The failure:** closing the R2 race put governed mutations on a queue, and
  moved the `context()` call *inside* the queued step. `context` is documented
  as called per operation "so one governed store can serve many actors" — which
  means an application sets it from whoever is being served right now. So a
  mutation asked for by one actor ran under whoever the context named by the
  time the queue reached it. A stranger's update, scheduled and then overtaken
  by the owner's request, committed **and was audited** as the owner. The
  pre-fix build denied the same call. No busy queue is needed: the promise hop
  the queue itself adds is enough.
- **Us:** ours, introduced 2026-09-18 and fixed 2026-09-19.
- **Evidence:** Astra's `governance-probes.mjs`, second probe, on the merged
  build: `{calledAs: "stranger", result: "committed", actualConfidence: 0.1,
  auditActors: ["owner"]}`. After the fix, the same probe:
  `{result: "personal-defaults: stranger is not the owner and cannot change the
  owner's memory", actualConfidence: 1, auditActors: ["stranger"]}`. Three
  tests in `src/governance/governed-race.test.ts` ("a queued mutation keeps the
  authority it was called with") fail first on `cce9cf9`; the five tests that
  prove R2 is still closed are in the same file and still pass.
- **Notes:** the shape is the lesson, and it is a general one: a fix that
  introduces a queue moves *when* things happen, and anything read at the point
  of execution silently becomes late. The rule now written into the code is
  **who is fixed at call time, when is read at run time** — authority must not
  drift, but an audit event must still carry the instant the change landed, so
  freezing the whole context would have been the opposite mistake. A reviewer
  should ask what else in this library is read after an `await` that was
  written before one.

### A claim that was a read and a write
- **Reported by:** GPT-6-Astra, same re-review, 2026-09-19.
- **The failure:** recording a scope inside a database — the other half of the
  R1 fix — read the stamp and then wrote it, with nothing holding the two
  together. Two processes that both looked at an unstamped 0.4.1 file before
  either wrote both found it free, and `INSERT OR REPLACE` let the second
  overwrite the first's name. Both opened it, both wrote into it, and each
  recalled the other's private facts: R1 again, through the mechanism added to
  prevent R1.
- **Us:** ours, introduced 2026-09-18 and fixed 2026-09-19.
- **Evidence:** reproduced with two real processes parked between the read and
  the write (`src/scope-claim-race.test.ts`, which fails on `cce9cf9` with both
  processes opening and one reading `["a private fact from 1", "a private fact
  from 2"]`). The claim is now one `BEGIN IMMEDIATE` transaction — the write
  lock is taken *before* the stamp is read — with a conditional insert and a
  read-back inside it, so the value the caller is told about is the value in the
  file. Astra's own `scope-race.mjs`, with its barrier matched to the new SQL,
  now reports one process claiming and the other exiting 1.
- **Notes:** this is the same defect as R2 one layer down, and worth saying so
  in the paper: "check, then act" is not a guarantee at any level — in the
  governed store it needed a queue, in SQLite it needed `IMMEDIATE`. It is also
  the one place in this library where a cross-process guarantee is real rather
  than per-process, because SQLite is doing the work.

### A new filename that was somebody else's old one
- **Reported by:** GPT-6-Astra, same re-review, 2026-09-19.
- **The failure:** the R1 fix gave each scope a filename of `<stub>-<16 hex>`,
  and resolved to it the moment a file existed there, without asking whose it
  was. But the *old* scheme's output was `<anything over [A-Za-z0-9_-]>.db` — so
  a canonical name was a name the old scheme could also produce. A 0.4.1 project
  called literally `foo-2c26b46b68ffc68f` owned the exact file that the new
  scope `foo` resolved to: `foo` claimed it, stamped it, and read its private
  facts, while the original owner reopened to an empty store. No collision under
  the old scheme was needed, which is why the "only already-mixed stores lose
  access" claim in this file was wrong.
- **Us:** ours, introduced 2026-09-18 and fixed 2026-09-19.
- **Evidence:** Astra's `scope-probes.mjs` on the merged build read
  `["unrelated legacy private memory"]` for the scope `foo` and `[]` for its
  rightful owner; after the fix it reads `[]` and
  `["unrelated legacy private memory"]` respectively, and the ordinary 0.4.1
  migration in the same probe still lands on the old file. Two tests in
  `src/project-memory-isolation.test.ts` fail first on `cce9cf9`.
- **Notes:** the fix is one character — the separator is a dot, and `slug()`
  strips every dot, so a canonical stem always contains something the old scheme
  could not leave behind. That is the point worth making: the two namespaces now
  *cannot* meet, instead of being checked for meeting. `projectDbPath` was
  tightened as well (it prefers the canonical path only when the file there is
  stamped with this scope), but that is belt to the braces. A reviewer should
  push on the fact that this class of bug — a new key space that overlaps an old
  one — is invisible to every test written about the new scheme alone.

### Two fixes that did not compose: a retraction the audit latch refused
- **Reported by:** GPT-6-Astra, same re-review, 2026-09-19.
- **The failure:** one 2026-09-18 fix made consolidation retract a derived fact
  whose evidence edges could not be written; another latched a failed audit sink
  so the store refuses every later change. When the audit sink is what failed,
  the compensating retraction is itself a change — so it was refused, the pass
  threw, and the conclusion stayed **live, unretracted, resting on one of its
  two evidence edges**. Each fix was correct alone and the pair was not, which
  is the only way this could have passed both reviews.
- **Us:** ours, introduced 2026-09-18 and fixed 2026-09-19.
- **Evidence:** `src/consolidation.test.ts`, "does not leave a conclusion
  standing when the audit trail dies mid-pass" — fails on `cce9cf9` with
  `expected null not to be null` on the derived fact's `validTo`.
- **Notes:** the interesting part is what the fix is *not*. Letting the
  retraction bypass the latch would have undone the other fix, so the order was
  inverted instead: a derived fact is written already retracted and is stood up
  by a final update that happens only after every evidence edge is recorded.
  There is then nothing to compensate — every way the pass can die leaves a
  withdrawn conclusion rather than an unsupported one. The cost is one extra
  write and one extra audit event per derived fact, and the stand-up is audited
  with purpose `invalidate`, because the store classifies any change to a fact's
  validity that way, in either direction. The general lesson for the paper:
  **compensating actions do not work through the mechanism that is broken**, so
  a system that recovers by writing must be able to fail without writing.

### The MCP handshake did not fit the character budget it was written for
- **Reported by:** ourselves, 2026-09-18, checking our own 0.4.1 claim.
- **The failure:** `SERVER_INSTRUCTIONS` exists because some MCP clients truncate
  the `instructions` string, and 0.4.1 claimed the essentials fit in the first 512
  characters. The string was 637. A client that truncates was told to recall and
  to remember, and never reached the rule that tells it to *invalidate* — so the
  one behaviour that keeps a memory honest over time was the one most likely to
  be cut.
- **Us:** shared it, fixed in 0.4.2.
- **Evidence:** `src/mcp/governance-server.ts`, `SERVER_INSTRUCTIONS`; measured
  length **507**, and `src/mcp/governance-server.test.ts:109` asserts
  `length <= 512` on every run. All six rules are still there.
- **Corrected 2026-09-19.** This entry sat in section C saying "open" and "637
  characters" after the rewrite had already shipped — a stale entry in the file
  whose whole purpose is that its entries are checked. Counting the string took
  one line of Node; nobody re-ran it after the fix. The entry was moved here
  rather than deleted.
- **Notes:** the interesting part for the paper is that this was a claim about a
  fix for an invocation failure, and it was itself unmeasured — twice: once when
  the budget was claimed and never counted, and once when the count was fixed and
  the ledger was not. The test is what stops a third time; a prose claim about a
  number is not evidence that anyone measured it.

### A guarantee that stopped at the type system
- **Reported by:** two independent reviews of 0.4.1 — GPT-6-Astra (R5, R8) and
  Claude Fable 5.1 — 2026-09-18, both finding it separately.
- **The failure:** the schema was enforced by TypeScript and nothing else, so a
  JavaScript caller, an import, or a port in another language could write
  `provenance:"Hacker"`, `memoryType:"Whatever"`, `retentionTier:"Forever"`,
  `privacyClassification:"sensitive"`, or an edge with `strength: 7`. The
  lower-case classification is the dangerous one: every governance rule here
  compares the classification by string equality, so a fact the person meant to
  hide was Sensitive to no policy and WAS returned to a stranger. The store's
  own export then failed its own published schema under ajv. Two more of the
  same shape: `{validTo: undefined}` from JavaScript left the field undefined in
  one store and mangled it in the other, and the import preflight — which
  promised to validate the whole artifact before touching a store — checked six
  field shapes while the real rules lived one node too late in `restoreNode`, so
  a bad second node left the first one committed.
- **Us:** shared it, fixed.
- **Evidence:** `src/instant.ts` `assertNodeVocabulary` / `assertEdge` /
  `assertAnchorEvent`, called from `canonicalNew`, `canonicalPatch`,
  `canonicalNode`, `canonicalEdge` and both stores' `addEdge`;
  `validatePortable` + `preflightDestination` in `src/memory-portability.ts`.
  Tests: "refuses a word outside the published vocabulary, on every write path"
  and "treats an undefined patch value as an absent key" in
  `src/memory-store-conformance.spec.ts` (both stores); "cannot be talked into
  exporting an artifact the schema rejects" in `src/portable-schema.test.ts`;
  the ten-case "refuses the whole artifact before writing any of it" table in
  `src/memory-portability.test.ts`.
- **Notes:** a reviewer should push back that this is still not a schema
  validator — structured content and metadata payloads are not checked, and
  import atomicity is a preflight rather than a transaction, which
  `importPortable` now says in its own docstring rather than in a claim.

### The filter that ran after the page instead of inside the read
- **Reported by:** GPT-6-Astra (R7, R11, R12) and Claude Fable 5.1, 2026-09-18.
- **The failure:** three reads asked the store for N rows and then narrowed them
  in JavaScript, so each could answer "nothing" while the answer sat in the
  store. Pinned rules — the tier whose whole claim is "in every prompt" —
  vanished once 500 newer Lessons existed, and re-pinning then duplicated them.
  A consolidation pass read the 5,000 most confident facts and filtered by date
  afterwards, so a store of 5,100 older facts hid everything recorded today. MCP
  recall took twice the page and dropped superseded facts afterwards, so sixteen
  retired facts about one subject produced an empty answer.
- **Us:** shared it, fixed. This is the most instructive entry of the three: the
  same mistake, made three times, in three unrelated files, by people who knew
  the rule.
- **Evidence:** `src/pinned.ts` `list()` now reads `tags:[PINNED_TAG]` with no
  limit; `src/consolidation.ts` reads unlimited; `src/mcp/governance-server.ts`
  `recall` passes `validAt`. Tests: "a pin survives 600 newer Lessons" (both
  stores) in `src/pinned.test.ts`; "reads today's facts even when the store
  holds thousands of older, more confident ones" in `src/consolidation.test.ts`;
  "finds the fact that is still true under sixteen retired ones" in
  `src/mcp-recall-validity.test.ts`.
- **Notes:** the honest cost is that a consolidation pass now reads the whole
  store; pushing `since` into the query is the next step if that ever bites. And
  the store's cursor pagination is still known-inconsistent (CHANGELOG), which
  is why none of these fixes pages.

### An export that was never one state of the store
- **Reported by:** GPT-6-Astra (R6), 2026-09-18, reproduced in both stores.
- **The failure:** `exportPortable` enumerated the nodes, then fetched each
  node's edges one `await` at a time. A delete landing in between produced an
  artifact of two nodes and zero edges — a graph the store had never been in.
  "Lossless backup" is a claim about a state, and this was not one.
- **Us:** shared it, fixed for both shipped stores; documented where it cannot
  be.
- **Evidence:** `snapshot()` on `SqliteMemoryStore` (nodes and edges inside one
  read transaction) and on `InMemoryStore` (both reads with no await between);
  `graphOf` in `src/memory-portability.ts` asks for it before its first await.
  Test: "a write during the export cannot produce a graph that never existed",
  both stores, in `src/memory-portability.test.ts`.
- **Notes:** a wrapper that does not implement `snapshot()` — a governed
  `exportView`, or somebody else's `MemoryStore` — still gets the two-phase
  read, and its export is only as consistent as the writes happening during it.
  That is written into the code, not left implied. Across several projects the
  artifact is one snapshot per store and never one instant across all of them:
  they are separate databases.
### One brain per project was one brain per *filename*
- **Reported by:** two independent reviews of 0.4.1 before the 2026-09-22 release
  (Claude Fable 5.1 and GPT-6-Astra), 2026-09-18. Filed as R1.
- **The failure:** scope isolation enforced by sanitising a name into a filename
  is not isolation, because sanitising is lossy. `projectDbPath` mapped every
  character outside `[a-zA-Z0-9_-]` to `-`, so the scopes `org/repo` and
  `org-repo` resolved to the same `org-repo.db` and each recalled the other's
  private facts — while the class comment and the README both promised a
  separate brain per project. Testable in four lines: capture in one scope,
  recall from the other.
- **Us:** shared it, fixed in 0.4.2.
- **Evidence:** `src/project-memory-isolation.test.ts` — the review's
  reproduction is the first test and fails on 0.4.1 (`expected [ { …(13) } ] to
  have a length of +0 but got 1`). The filename now carries 64 bits of SHA-256
  over the whole scope (`canonicalProjectDbPath`), and the scope is written
  *inside* the database (schema v6, `memory_meta`), so a store opened under a
  different name throws rather than merging. An existing store is never moved
  and never stranded: a file from 0.4.1 records no scope, so the first project
  to open it claims it.
- **Corrected 2026-09-19.** Two sentences above were not true of the code as
  merged, and both are now. (1) "The first project to open it claims it" was a
  read of the stamp followed by a write of it, with nothing holding the two
  together, so two processes could both claim one file — see *A claim that was
  a read and a write* below. (2) "An existing store is never stranded" had a
  second exception nobody had found: not only already-mixed files, but a file
  that had never collided with anything — see *A new filename that was somebody
  else's old one* below. Both are fixed; the claims above hold now, and did not
  when they were written.
- **Notes:** a reviewer should push on the one case that cannot be repaired — a
  file two scopes were *already* sharing holds both scopes' facts interleaved,
  and no machine can split them. The claimant keeps the file, the other scope
  starts clean, and nothing is deleted. Say that plainly rather than calling the
  migration lossless. The general lesson is the entry: **a lossy function is
  not an isolation boundary**, and any system that derives a tenant key by
  sanitising a name has this bug.

### Authorisation that had already gone stale by the time it was used
- **Reported by:** the same two reviews, 2026-09-18. Filed as R2.
- **The failure:** governance hooks are asynchronous by design, so every `await`
  between "may this actor change this fact?" and the write itself is a window.
  An agent's permitted update, paused in a policy, committed *after* the owner
  had reclassified the fact as Sensitive — and left it Private and readable. No
  raw-store access is needed; two governed handles are enough.
- **Us:** shared it, fixed in 0.4.2.
- **Evidence:** `src/governance/governed-race.test.ts` — four tests
  (update, erase, import, link) fail deterministically on 0.4.1 with
  `expected 'Sensitive' to be 'Private'`. Governed mutations over one store now
  run one at a time, queued on the inner store so every handle over it shares
  the queue; reads are not queued.
- **Corrected 2026-09-19.** The fix above shipped with a hole of its own, and it
  was worse than what it closed — see *A queue that also deferred the question
  of who was asking* below. The entry stands; the fix it describes did not, for
  a day.
- **Notes:** **partial, and the limit is the interesting part.** This serialises
  one process. Two processes on one SQLite file still have only SQLite's write
  lock, which protects the write and not the decision before it — a real
  guarantee needs the check and the write in one transaction. The paper should
  use this as the example of why "we check permissions before every write" is an
  incomplete claim: the question is whether anything can happen in between.

### An audit sink that failed once, and a store that carried on
- **Reported by:** the same two reviews, 2026-09-18. Filed as R3.
- **The failure:** every mutator wrote to the store and then recorded. When the
  sink tore mid-append, `ChainedAudit` correctly refused to append again — and
  the store kept accepting writes, each one rejecting to the caller. An MCP
  client that retries therefore compounded changes that nothing could attest to:
  three facts persisted behind one complete audit event in the reproduction.
- **Us:** shared it, fixed in 0.4.2 — for everything after the first failure.
- **Evidence:** `src/governance/audit-poison.test.ts` — four of its five tests
  fail on 0.4.1 (`expected [ Array(4) ] to deeply equal [ 'first', 'second' ]`).
  The failure is latched on the sink, so every handle sharing it refuses the
  next mutation before touching the store.
- **Corrected 2026-09-19.** "The single write that breaks the sink" was the
  claim; the code allowed twenty. `addNode` was deliberately left off the
  mutation queue, and a latch can only refuse a call that has not started, so
  every concurrent add cleared the check before the first failure was observed.
  Measured on the merged build: twenty concurrent adds, twenty rejected callers,
  **twenty** facts persisted, one audit append. `addNode` is queued now and the
  same probe reports one persisted fact — the number both this entry and
  `docs/policies/ENFORCEMENT.md` had been asserting. The sentence below was
  written as a limit and was in fact an understatement; it is a bound now.
- **Notes:** the entry is only worth having if it states what is *not* fixed. A
  mutation still commits before its event is written, so the single write that
  breaks the sink is unrecorded — documented since 0.4.0 in
  `docs/policies/ENFORCEMENT.md`.
- **Extended 2026-09-19 (unreleased).** That window is now closed on one path and one
  only: a store whose trail is its own `audit_events` table, where the event is
  in the fact's transaction (this section, *A commit that could outlive its own
  audit event*). On every sink that writes beside the database the window is
  exactly as described above and stays open — section C. So "every commit is
  audited" is a claim this library makes **only with that clause attached**, and
  the paper must carry the clause every time, not the headline.

### Two assistants, one memory, and a chain with two writers
- **Reported by:** the same two reviews, 2026-09-18. Filed as B1.
- **The failure:** a hash chain has exactly one writer. The README's MCP config
  is one `npx` per host and the server's own handshake says the memory is
  "shared across their assistants" — so the documented, intended setup put two
  processes on one log. Each cached its own head, the appends interleaved, the
  chain forked, and from then on *every* server refused to start, because
  refusing to extend a broken chain is the correct behaviour.
- **Us:** shared it, fixed in 0.4.2.
- **Evidence:** reproduced with two real server processes on one database: the
  shared log breaks at line 3 of 6 and a third server exits 1 with
  `does not verify … refusing to extend it`. After the fix, the same two
  processes write `brain.db.audit/2026-09-19T05-10-59.025Z-17218.jsonl` and
  `…-17219.jsonl`, both `intact: 3 events`, and a third server starts. Tests:
  `src/governance/audit-per-writer.test.ts` (six), `src/sqlite-busy.test.ts`
  (six). `verify-audit` now takes the directory.
- **Notes:** a lock file was considered and rejected — making the second
  assistant fail to start is a worse failure than two logs that each verify. The
  cost is stated: N logs is N heads to anchor, and the split itself is not
  evidence of anything, so a reviewer should ask what stops a writer from
  quietly dropping its own log. Nothing does; that is the same tail-truncation
  limit the chain already has, multiplied.
- **Superseded for new trails, 2026-09-19 (unreleased).** The split was the price of
  letting two processes share a chain kept in a *file*. A chain kept in the
  database does not pay it: the tail is read and extended under SQLite's write
  lock, so one chain takes many writers (`src/governance/audit-cross-process.test.ts`,
  two real processes, forty interleaved facts). That is the MCP server's default
  now, and it removes the N-heads and quietly-dropped-log costs for trails
  written from here on. It does **not** repair an existing directory of logs:
  those keep every limit named above and are still checked on those terms, which
  `verify-audit <db>` reports alongside the table. Alongside it, the SQLite constructor
  now retries `SQLITE_BUSY` — better-sqlite3's busy timeout does not cover the
  `journal_mode = WAL` switch, so two servers starting together could fail
  outright.

### A published install line that returned 404
- **Reported by:** the same two reviews, 2026-09-18. Filed as R4.
- **The failure:** the quickstart nobody on the team ran from outside the
  repository. `npx al-buddy-memory-mcp` names an executable inside the
  `al-buddy-memory` package, not a package — npm returns E404. The same example
  passed `~/.al-buddy-memory/brain.db` as an environment value, and nothing
  expanded the `~`, so a literal `./~/.al-buddy-memory/` directory appeared
  under the client's working directory.
- **Us:** shared it, fixed in 0.4.2.
- **Evidence:** both halves reproduced in a clean directory against the
  published 0.4.1 — `npm error 404 The requested resource
  'al-buddy-memory-mcp@*' could not be found`, and a `./~/.al-buddy-memory/brain.db`
  created on disk. The corrected line,
  `npx -y --package=al-buddy-memory@0.4.1 al-buddy-memory-mcp`, was then driven
  through a real MCP handshake — `initialize`, `tools/list`, `remember`,
  `recall` — against the published package. `expandHome` covers the tilde for
  anyone who sets the variable anyway (`src/home-path.test.ts`).
- **Notes:** this is the least technical entry and the one most worth keeping.
  Every other guarantee in this file is unreachable behind an install command
  that does not run, and no test in the repository could have caught it, because
  every test ran inside the repository. The method that belongs in the paper:
  **verify the published artifact from outside, with the exact published
  configuration.**

### Tied reads returned the oldest facts
- **Reported by:** an outside bug report, before 0.4.0 (2026-09).
- **The failure:** when ranking scores tied, the read returned the oldest matching
  facts rather than the most relevant — so a memory system silently preferred
  stale information exactly where it was least sure.
- **Us:** shared it, fixed in 0.4.0.
- **Evidence:** CHANGELOG 0.4.0, which opens on this report.
- **Notes:** the more useful part is what it led to — see the next entry.

### Headline claims that were not true in the code
- **Reported by:** ourselves, chasing the tied-reads report; then two independent
  reviews of the whole library (2026-09-14).
- **The failure:** several of this project's own documented guarantees were not
  implemented as described. This is the single most important entry in the file:
  the gap between a memory system's README and its behaviour is the thing a paper
  reviewer will probe hardest, and we found ours by looking.
- **Us:** shared it, fixed. 0.4.0 "makes them true or stops making them" — some
  claims were implemented, others withdrawn rather than defended.
- **Evidence:** CHANGELOG 0.4.0 preamble; 11 Tier-1 defects were raised across the
  reviews and closed before publication. 0.3.4 and 0.3.5 were staged and never
  published.
- **Notes:** the method generalises and belongs in the paper as method, not
  anecdote: audit every stated guarantee against a test, and withdraw the ones
  that do not survive.

### A memory the client never calls
- **Reported by:** ourselves, 0.4.1 (2026-09-15).
- **The failure:** Claude Desktop connected to the 0.4.0 MCP server five times and
  never called a single tool. Recall quality is irrelevant when the host never
  invokes it — an evaluation that measures retrieval in isolation would have
  scored this a success while the user got nothing.
- **Us:** shared it, fixed in 0.4.1.
- **Evidence:** the server now sends `instructions` at connection
  (`SERVER_INSTRUCTIONS`, `src/mcp/governance-server.ts:91`).
- **Corrected 2026-09-18:** this entry previously said the essentials were "inside
  the first 512 characters because some clients truncate there." Measured, the
  string is **637 characters**; character 512 falls mid-sentence at "When a fact".
  The recall and remember rules are inside the budget; the invalidate and pin
  rules are not. The correction stands here rather than being deleted (rule 4),
  and the shortfall is now carried in section C. This is itself the ledger working
  as intended: a claim about our own fix was checked by counting, and it was wrong.
- **Notes:** this is a genuinely under-reported failure mode and is worth its own
  section in the paper. It argues that agent-memory benchmarks should measure
  *invocation* as well as retrieval. The 512-character miss belongs in that section
  too — being told to use the memory and being told *how to retire a fact* are
  different things, and only the first survived truncation.

### A comparison table that was wrong about other people's products
- **Reported by:** two independent reviews of this repo (Claude Fable 5.1 and
  GPT-6-Astra), 2026-09-18, before the Show HN.
- **The failure:** the README compares this library by name with Letta, Mem0 and
  Zep. Three cells were wrong or stale, and a project's own maintainer would have
  been the one to correct them, publicly, on launch day. Naming competitors is the
  thing that makes this README credible; getting them wrong is the thing that
  destroys it, and the risk is entirely self-inflicted.
- **Us:** shared it, fixed 2026-09-18.
- **Evidence:** Mem0's "when was it true" cell said **"No"**. It keeps a per-memory
  change history — a SQLite table with `old_memory`, `new_memory`, `event`,
  `created_at`, `updated_at` (`mem0/memory/storage.py`, read 2026-09-18). That is
  transaction history and not valid time, which is the accurate distinction and is
  now what the cell says. Mem0's "no vendor" cell said **"Cloud is the product"**;
  Mem0 is Apache-2.0 (GitHub API, `spdx_id: Apache-2.0`) and runs against local
  vector stores, though an LLM is called to extract facts. Zep's cell said **"Cloud
  only"**; Zep Community Edition was discontinued on 2025-04-02 in Zep's own words
  ("we've decided to stop maintaining and releasing Zep Community Edition"), but
  Graphiti — the engine underneath it — is Apache-2.0 and self-hosts, requiring a
  graph database and, per its own README, an LLM key. The Letta cell was checked
  and left alone.
- **Notes:** the method is the transferable part, and it is the same one this
  library applies to facts: a claim about someone else is only as good as the
  source it is anchored to, and the sources are now dated in the README beside the
  table. A reviewer should push back that this was found by review and not by our
  own process — true, and the reason the table now carries a date and links.

### A landing page that outlived the claims the library withdrew
- **Reported by:** the same 2026-09-18 reviews.
- **The failure:** 0.4.0 withdrew "nothing is deleted" from the README and
  GOVERNANCE because it was not true — erasure exists, governed and audited.
  `albuddy.com` went on saying it for three more releases, including under a
  heading reading **"Enforced in code"**, which is the worst possible place for a
  claim the code does not enforce. The generalisable failure: withdrawing a claim
  from the documents a maintainer edits does not withdraw it from the page a
  visitor reads first.
- **Us:** shared it, fixed 2026-09-18.
- **Evidence:** CHANGELOG 0.4.0 "Docs that claimed more than the code did" records
  the original withdrawal. `docs/demo/index.html` carried it in three more places
  — the `og:description`, the "Never deleted" card, and the "Enforced in code"
  card — until this change. All three now say invalidate-not-overwrite, with
  erasure named as existing, policy-gated and audited.
- **Notes:** worth saying in the paper that a withdrawn claim needs a sweep, not an
  edit. We had no check that would have caught this; the honest statement is that a
  human review found it, four days before it would have been read by strangers.

### A benchmark that only measured the path we were fast on
- **Reported by:** the same 2026-09-18 reviews.
- **The failure:** the README's "Limits, measured" table reported the keyword path
  at 100,000 facts in detail and said nothing at all about the vector path, which
  is the expensive one. A limits table that omits the worst case is marketing
  wearing a table's clothes.
- **Us:** shared it, fixed 2026-09-18 — measured and published, not estimated.
- **Evidence:** `bench/bench-vectors.mjs`, same laptop and method as `bench.mjs`.
  At 20,000 facts: 172 MB on disk, semantic recall 765 ms on the first call of a
  session and 36 ms median after. At 100,000: 864 MB, 3,196 ms cold, 187 ms median
  warm. Vectors are stored as JSON text at ~8.0 KB per 384-dimension vector against
  1.5 KB for the same floats as binary; the same 100,000 facts are 69.5 MB without
  vectors, which matches the 69 MB already in the README table and is the
  cross-check that the two harnesses agree. Recall is a brute-force linear scan.
- **Notes:** a reviewer should push back that the benchmark uses synthetic
  384-dimension vectors rather than real model output. That is deliberate — it
  measures storage and scan cost, not embedding quality — and it is faithful on the
  point that matters, because the shipped embedder is fp32 and its `tolist()` values
  serialise to ~7.75 KB, within 1% of the synthetic figure. What it does not measure
  is the embedder's own runtime or the 25 MB model download.

---

## C. Open — known, not yet fixed

### A refusal that is right but unreadable
- **Reported by:** our own CI, 2026-09-19, after the atomic scope-claim fix.
- **The failure:** when two processes race for one store, the loser is correctly
  refused — but if SQLite's write lock (`BEGIN IMMEDIATE`) bites before the scope
  comparison is reached, the message is `database is locked` rather than a sentence
  naming the project that owns the file. Which one a person sees is a timing
  coin-flip.
- **Us:** shared it, **open**. The isolation guarantee holds; only the explanation
  is poor.
- **Evidence:** `src/scope-claim-race.test.ts` accepts either message and says why.
- **Notes:** the fix is to translate a lock refusal on the claim path into the scope
  message, which needs care not to mask a genuine lock contention elsewhere. Not
  rushed in three days before a release for a wording problem.

### Two of the seven conformance dimensions rest on a declared trait
- **Reported by:** the 2026-09-18 reviews, pushing on "it grades its own homework".
- **The failure:** `docs/SCORING.md` said "adapters map only what the export
  records". For five dimensions that is true. For `invalidation`, and for the
  schema and itemised thirds of `portability`, the value is asserted by whoever
  wrote the adapter, not read from the file — so a scorer that presents itself as
  reading only the artifact is overstating its own objectivity.
- **Us:** shared it, documented 2026-09-18, not closed.
- **Evidence:** `src/conformance/adapters.ts:57,95-98,134-137` set the traits per
  adapter; `src/conformance/score.ts` reads them straight through. The round-trip
  third *is* executed where an importer exists (`proveRoundTrip`, `adapters.ts:20`).
  SCORING.md and the README now say which is which, and the reason line in every
  report repeats the declared trait verbatim.
- **Notes:** documenting an overstatement is not the same as removing it, which is
  why this sits in C and not in B. The real fix is either to derive the traits from
  the artifact where that is possible, or to report the two declared dimensions
  separately from the five measured ones. Neither is done.

### Vector recall is a brute-force scan over JSON text
- **Reported by:** ourselves, measuring for the entry above, 2026-09-18.
- **The failure:** semantic recall reads and scores every stored vector, and the
  vectors are kept as JSON text. At 100,000 facts that is 800 MB of text and a
  3.2-second first query. A memory system whose recall degrades linearly has a
  ceiling, and the ceiling should be stated before someone finds it.
- **Us:** shared it, open — measured and published rather than fixed.
- **Evidence:** `src/hybrid-retriever.ts` `vectorCandidates` scores the full model
  space; `src/sqlite-memory-store.ts:868` stores `JSON.stringify(vector)` in a TEXT
  column. Numbers in README "Limits, measured".
- **Notes:** the two obvious moves are storing the vector as a BLOB (~5× smaller)
  and handing the search to `sqlite-vec`. Neither is started. The honest framing is
  that this library's contribution is provenance and portability, and its recall
  implementation is the naive one.
*These come out of the section-B fixes above. Each one is the part of a fix that
was not finished, kept here so nobody has to re-derive it from the code.*

### The commit-before-event window, wherever the trail is not in the database
- **Reported by:** ourselves, 0.4.0; raised again by both 0.4.1 reviews as the
  half of R3 that the 0.4.2 latch does not close, 2026-09-18. Closed for the
  database's own table by the audit table (section B, *A commit that could outlive its own
  audit event*); this is the remainder, kept rather than deleted.
- **The failure:** with any sink that writes beside the database — `JsonlAudit`,
  `ChainedAudit`, anything a caller supplies — a governed mutation commits and
  *then* its event is written. If the sink fails at that moment the fact is in
  the database and nothing attests to it, while the caller is told the operation
  failed.
- **Us:** shared it, **open on that path, and expected to stay open.** A file
  cannot join a database transaction, and a store that is not SQLite may have no
  transaction to join. 0.4.2 fixed everything after the window (the sink is
  latched, so the next mutation is refused before it reaches the store); the
  audit table added a path on which the window does not exist. Neither removes it here.
- **Evidence:** `src/governance/audit-poison.test.ts` — the first test asserts
  exactly two facts persist on the JSONL path (the one that succeeded and the
  one that broke the sink), and a second puts twenty concurrent writes through
  the same failure and asserts **one** persists, because "one unrecorded write"
  is only a bound if nothing can be in flight beside it. Against it,
  `src/governance/audit-table.test.ts` asserts **zero** on the table path.
- **Notes:** the consequence for the paper is a clause, not a headline. "Every
  commit is audited" is true of a store keeping its trail in its own database
  and is not true of the file sinks, and the sentence has to say which. A reader
  who sees only the audit-table note will over-read it; that is why this entry is
  still in section C.

### Governed serialisation is per process
- **Reported by:** ourselves, closing R2, 2026-09-18.
- **The failure:** authorisation and mutation now run as one step within a
  process, but two processes on one SQLite file share only SQLite's write lock,
  which protects the write and not the decision that preceded it. The R2
  interleaving is therefore still reachable across processes — and the shipped
  MCP server is explicitly a two-process setup (see B1).
- **Us:** shared it, **open**.
- **Evidence:** `src/governance/governed-store.ts`, the `serialise` comment;
  `docs/GOVERNANCE.md`, "What one process guarantees, and what it does not".
- **Narrowed, not closed, 2026-09-19 (unreleased).** Moving the audit trail into the
  database changed what can be *seen*, not what is *enforced*. Two processes'
  events are now one totally-ordered chain instead of two files that cannot be
  ordered against each other, so an interleaving is legible after the fact
  (`src/governance/audit-cross-process.test.ts`). The decision itself still
  happens before the transaction opens: a policy that read a fact, awaited, and
  then wrote can still be judging a row another process has already changed. The
  new test deliberately proves only the chain property and claims nothing about
  authorisation — do not let its name suggest otherwise.
- **Notes:** the honest fix is the check and the write in one database
  transaction, which means pushing policy evaluation down to the store or
  holding a row-level revision and revalidating on conflict. Neither is built.
  The second is now within reach — a mutation already runs inside one
  `BEGIN IMMEDIATE` in `SqliteMemoryStore.mutation()`, so re-reading the row
  there and refusing if it changed under the decision is a contained change. It
  was left out of the audit-table change on purpose: it adds a new failure mode (a conflict a
  caller must handle) to a release that already needed reviewing in a day. A
  reviewer who only reads the tests will think this is closed; it is not.

### Two scopes that already shared a file cannot be un-mixed
- **Reported by:** ourselves, closing R1, 2026-09-18.
- **The failure:** 0.4.2 stops two scopes sharing a database. It cannot undo the
  ones that already did: the facts are interleaved in one file with nothing
  recording which scope wrote which.
- **Us:** shared it, **open** — and probably permanently, which is itself the
  finding.
- **Evidence:** `src/project-memory.ts`, `projectDbPath`; the colliding-pair
  test in `src/project-memory-isolation.test.ts` asserts the behaviour rather
  than a repair — the first scope to open keeps the file, the second starts
  clean, nothing is deleted.
- **Corrected 2026-09-19.** As written, this entry said the *only* stores that
  lose access are the ones two scopes were already sharing. That was not true of
  the code it described: a 0.4.1 store that had never collided with anything
  could also be taken over, because the new filename scheme could spell a name
  the old one had already used (section B, *A new filename that was somebody
  else's old one*). That second case is now fixed and this entry covers only the
  already-mixed one, which is what it always claimed to cover.
- **Notes:** the general lesson for the paper is that **provenance has to record
  the scope at write time**, not derive it from where the fact happens to be
  stored. Facts written before 0.4.2 carry no scope, so the information needed
  to repair this was never captured. Facts written from 0.4.2 on sit in a file
  that names its own scope.

---

## Related

- `docs/SPEC.md` — what the format guarantees.
- `docs/GOVERNANCE.md` — what is enforced rather than implied.
- `docs/SCORING.md` — the conformance score.
- README "Limits, measured" — the measured performance envelope, including worst
  cases. Keep new numbers there, and reference them here.
