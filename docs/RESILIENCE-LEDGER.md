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

*Nothing is listed here yet. An empty section is a claim in itself; if it stays
empty for long, that is a sign this ledger is not being kept honestly rather than
a sign the library is perfect.*

---

## Related

- `docs/SPEC.md` — what the format guarantees.
- `docs/GOVERNANCE.md` — what is enforced rather than implied.
- `docs/SCORING.md` — the conformance score.
- README "Limits, measured" — the measured performance envelope, including worst
  cases. Keep new numbers there, and reference them here.
