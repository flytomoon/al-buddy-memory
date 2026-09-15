# Contributing

Thank you. Three kinds of contribution are most useful right now, in this order:

1. **A conformance adapter for your export shape** — see docs/SCORING.md "Adding an adapter".
   Hand-written fixtures only; never copy another project's files into this repo.
2. **A benchmark objection, or a policy objection** — open an issue with the "Scoring objection"
   template. If a rule is wrong it changes in the open (docs/SCORING.md, docs/policies/), with a
   test wherever one is possible.
3. **A backend** — implement `MemoryStore` and make `src/memory-store-conformance.spec.ts`
   pass against it. That suite is the contract.

## Ground rules

- `npm run check` must be green (typecheck, tests, bundle — what CI runs).
- Facts are invalidated, not overwritten; raw content and provenance are immutable; erasure
  only happens through governance. A PR that weakens any of that will be declined with thanks.
- A claim in the docs needs a test or a line in docs/policies/ENFORCEMENT.md saying it is not
  enforced. Two 0.3.5 comments asserted properties nothing checked; both were wrong.
- Write against shapes and specs, not other vendors. Comparisons live in the README table only.
- Apache-2.0, and by contributing you license your work the same way.
