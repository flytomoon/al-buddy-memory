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
- **Evidence:** `ChainedAudit` writes each governance event with the hash of the
  previous one (HMAC-SHA256); `verifyAuditChain` and
  `al-buddy-memory verify-audit` name the first edited, removed, inserted or
  reordered line. CHANGELOG 0.4.0.
- **Notes:** a rewrite by whoever holds the key is still possible — the chain is
  tamper-*evident*, not tamper-proof, and the paper must say so in those words.

---

## B. Failure modes we shared, and fixed

*These are the load-bearing entries. They show the system was tested against
reality rather than described.*

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
- **Notes:** the entry is only worth having if it states what is *not* fixed. A
  mutation still commits before its event is written, so the single write that
  breaks the sink is unrecorded — documented since 0.4.0 in
  `docs/policies/ENFORCEMENT.md` and deliberately kept, because closing it needs
  the event committed in the fact's own transaction (a transactional outbox),
  which is not built. "Every commit is audited" is therefore a claim this
  library does **not** make, and the paper must not make it either.

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
  limit the chain already has, multiplied. Alongside it, the SQLite constructor
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
- **Evidence:** the server now sends `instructions` at connection, with the
  essentials inside the first 512 characters because some clients truncate there.
  CHANGELOG 0.4.1.
- **Notes:** this is a genuinely under-reported failure mode and is worth its own
  section in the paper. It argues that agent-memory benchmarks should measure
  *invocation* as well as retrieval.

---

## C. Open — known, not yet fixed

*These come out of the section-B fixes above. Each one is the part of a fix that
was not finished, kept here so nobody has to re-derive it from the code.*

### A commit is not in the same transaction as its audit event
- **Reported by:** ourselves, 0.4.0; raised again by both 0.4.1 reviews as the
  half of R3 that the 0.4.2 latch does not close, 2026-09-18.
- **The failure:** a governed mutation commits, and *then* its event is written.
  If the sink fails at that moment, the fact is in the database and nothing
  attests to it, while the caller is told the operation failed.
- **Us:** shared it, **open**. What 0.4.2 fixed is everything after: the sink is
  latched, so the next mutation is refused before it reaches the store
  (`src/governance/audit-poison.test.ts`).
- **Evidence:** `docs/policies/ENFORCEMENT.md`, the audit row; the first test in
  `audit-poison.test.ts` asserts exactly two facts persist — the one that
  succeeded and the one that broke the sink.
- **Notes:** the fix is a transactional outbox, or an audit table written in the
  fact's own SQLite transaction. Until that exists, **"every commit is audited"
  is a claim this project does not make.** State the window in the paper rather
  than rounding it off.

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
- **Notes:** the honest fix is the check and the write in one database
  transaction, which means pushing policy evaluation down to the store or
  holding a row-level revision and revalidating on conflict. Neither is built.
  A reviewer who only reads the tests will think this is closed; it is not.

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
