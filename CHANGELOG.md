# Changelog

Notable changes, newest first. Dates are the release date; versions follow
[semantic versioning](https://semver.org). Anything that changes what an
existing caller gets back — even when the old answer was a bug — is called out
under **Behaviour change**, because a version number alone is not a warning.

## 0.3.4 — 2026-09-14

### Behaviour change — reads that tie now return the NEWEST, not the oldest

Reported from outside the project: `searchNodes` without a query read its
candidate pool newest-first in SQL, and then re-ranked in JavaScript with a
tie-break that ran oldest-first before truncating to `limit`. Every fact with
`decayRate: 0` carries the same effective confidence, so on any store where the
set outgrew the limit, a limited read returned the *oldest* n facts while the
unlimited read of the same query started with the newest. The thanks are owed
to the reporter; the diagnosis was exact.

Ordering is now one rule, stated once and shared by every store and by hybrid
recall:

> **effective confidence, then most recently learned, then node id.**

- "Most recently learned" is the `created` entry in `temporalAnchors`, exported
  as `learnedAt(node)` — *not* `validFrom`. `validFrom` is valid time and is
  deliberately backdatable ("this was true since March"), so it cannot order
  what the store learned when.
- `nodeId` is the final key because the anchor is a millisecond stamp and bulk
  writes collide inside one. Without it two stores — or two reads of one store —
  could disagree about a page boundary.
- `compareRecency(a, b)` is exported for callers doing their own ranking.

What this means for you: **a limited read is now the first page of the
unlimited one.** If you were relying on the old behaviour to get the oldest
facts, ask for them explicitly rather than by taking a short page.

### Fixed

- `HybridRetriever.recall` had the same class of defect one layer up: equal
  fused score and equal confidence left the winner of `slice(0, limit)` to
  whichever entry the fusion map happened to hold first. A tie there is not a
  corner case — it is the ordinary shape of reciprocal-rank fusion, where one
  fact wins the keyword list and the other wins the vector list. It now ends on
  `compareRecency`, the same last word as the stores.
- `InMemoryStore.searchNodes` had no tie-break at all; it now matches SQLite
  exactly, which is what the shared conformance suite exists to guarantee.

- `consolidate` now reads a night in a total order — oldest first, ties settled
  by node id — so a pass replays the same sequence on any machine and `maxRaw`
  always cuts in the same place. Same reasoning as above, read backwards: the
  stores page newest first, a pass replays oldest first, and neither order is
  left to chance.

### Internal

- Migration v4 rebuilds the ranking index to cover the new `ORDER BY`
  (`confidence_weight DESC, created_at DESC, node_id DESC`). It runs on open;
  nothing is asked of you.
- The conformance suite gained the invariant itself — more equal-confidence
  facts than both the limit and the candidate pool, asserting a limited read is
  a prefix of the unlimited one and that nothing newer was left out. It fails
  against 0.3.3.

## 0.3.3 — 2026-09-14

- An undo of a consolidation pass records that it was an undo, by whom, and why.
- Prior art credited in the README.

## 0.3.2 — 2026-09-14

- Scoped hybrid recall: type, tags, confidence and privacy/retention scope apply
  to the vector list as well as the keyword list, so a scoped recall cannot pull
  an out-of-scope fact in through the vector side.
- The tag filter applies before the limit, not after it.
- Review and undo a consolidation pass.

## 0.3.1 — 2026-09-10

- `bin` paths in the form npm accepts.
- First release through staged trusted publishing (OIDC + provenance); a
  maintainer approves each one with 2FA before it goes public.

## 0.3.0 — 2026-09-10

- Governance enforced rather than implied: policy hooks, immutable provenance.
- Limits measured at 100k facts and published.
- Conformance CLI, browser demo, and the governance MCP server.

## 0.2.0 — 2026-09-10

- The spec, the portable export format and its JSON Schema, published and
  versioned.
