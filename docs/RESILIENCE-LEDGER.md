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

### The MCP handshake does not fit the character budget it was written for
- **Reported by:** ourselves, 2026-09-18, checking our own 0.4.1 claim.
- **The failure:** `SERVER_INSTRUCTIONS` exists because some MCP clients truncate
  the `instructions` string, and 0.4.1 claimed the essentials fit in the first 512
  characters. The string is 637 characters. A client that truncates is told to
  recall and to remember, and never reaches the rule that tells it to *invalidate* —
  so the one behaviour that keeps a memory honest over time is the one most likely
  to be cut.
- **Us:** shared it, open.
- **Evidence:** `src/mcp/governance-server.ts:91-98`; measured length 637;
  character 512 falls inside "When a fact". A 506-character rewrite that keeps all
  six rules has been drafted and not yet applied.
- **Notes:** the interesting part for the paper is that this was a claim about a
  fix for an invocation failure, and it was itself unmeasured. Counting characters
  is cheap; nobody had.

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

---

## Related

- `docs/SPEC.md` — what the format guarantees.
- `docs/GOVERNANCE.md` — what is enforced rather than implied.
- `docs/SCORING.md` — the conformance score.
- README "Limits, measured" — the measured performance envelope, including worst
  cases. Keep new numbers there, and reference them here.
