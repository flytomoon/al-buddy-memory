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

## Releasing (maintainers)

One command, from an up-to-date, clean `main`, after the changes are written up under
`## X.Y.Z — unreleased` in CHANGELOG.md:

```
npm run release -- patch            # or minor, major, or an exact X.Y.Z
npm run release -- patch --dry-run  # every step printed, nothing changed
```

It refuses — and says why — off `main`, with uncommitted changes, when `main` is behind
`origin`, when the tag exists, when the CHANGELOG has no unreleased section for that version,
or when the name scan finds another project named outside the README table. Then it dates the
CHANGELOG, bumps `package.json` and the lock, runs typecheck, tests and build, commits, tags
`vX.Y.Z` and pushes `main` and the tag. The tag's workflow stages the npm publish; a maintainer
approves it with 2FA (npmjs.com → Staged Packages). Only after npm serves the new version:

```
npm run release:pin   # moves the README install line to the published version, tests, commits, pushes
```

The pin waits because an install line that names a version npm does not have yet fails for
everyone who copies it.
