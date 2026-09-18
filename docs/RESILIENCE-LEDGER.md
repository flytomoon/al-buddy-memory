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
