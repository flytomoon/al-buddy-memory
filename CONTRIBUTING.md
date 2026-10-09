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

## The public repo guard

This repository is public, so a push is checked before it leaves your machine for private
names and credentials — in commit messages, in every line a commit adds, and in file names.

```
npm run guard:install   # once per clone: installs .git/hooks/pre-push
npm run guard           # scan every commit not yet on a remote, by hand
npm run guard -- --range origin/main..HEAD
```

Two sources of rules:

- **Your deny list, kept outside the repo** — `~/.al-buddy-memory/private-names.txt`, or the
  path in `AL_BUDDY_MEMORY_PRIVATE_NAMES`. One name per line (an employer, a client, a person,
  an internal project); `#` starts a comment; matching is case-insensitive, on word edges, and
  any run of whitespace matches a space. No file means no names: only the built-ins run. A file
  that exists but cannot be read refuses the push rather than passing it. Never commit this
  file, and never put a real name in a test or doc as an example — the list's whole point is
  that its contents are not here.
- **Built-in generic patterns** (`scripts/public-guard-lib.mjs`): private key blocks; AWS,
  GitHub, Anthropic, OpenAI, Slack, Google, Stripe-live, npm and Telegram-bot credential shapes;
  and a `TODO-PRIVATE` marker you can leave on anything that must never ship. <!-- public-guard:allow -->

A hit refuses the push and prints the exact place — `commit abc1234 src/x.ts:12`, or the
message line, or the path — with the rule and the matched text (credentials are shown masked).
Rewrite the commit so the text is gone from history (`git commit --amend`, `git rebase`), then
push again: a later commit that deletes the line does not unpublish it. A built-in false
positive — a fixture, a doc showing a key's shape — can carry `public-guard:allow` on that
line; that exempts the built-ins only, never a deny-list name.

`npm run release` runs the same guard in its preflight: over the commits it is about to push,
and for deny-list names over the whole tree it ships.

## Releasing (maintainers)

One command, from an up-to-date, clean `main`, after the changes are written up under
`## X.Y.Z — unreleased` in CHANGELOG.md:

```
npm run release -- patch            # or minor, major, or an exact X.Y.Z
npm run release -- patch --dry-run  # every step printed, nothing changed
```

It refuses — and says why — off `main`, with uncommitted changes, when `main` is behind
`origin`, when the tag exists, when the CHANGELOG has no unreleased section for that version,
when the name scan finds another project named outside the README table, or when the public
repo guard (above) finds a private name or a credential. Then it dates the
CHANGELOG, bumps `package.json` and the lock, runs typecheck, tests and build, commits, tags
`vX.Y.Z` and pushes `main` and the tag. The tag's workflow stages the npm publish; a maintainer
approves it with 2FA (npmjs.com → Staged Packages). Only after npm serves the new version:

```
npm run release:pin   # moves the README install line to the published version, tests, commits, pushes
```

The pin waits because an install line that names a version npm does not have yet fails for
everyone who copies it.

The release also moves `server.json` — the [MCP Registry](https://registry.modelcontextprotocol.io)
entry — to the new version. The registry reads `mcpName` from that version on npm, so list it
only after npm serves it, from `main` with [`mcp-publisher`](https://github.com/modelcontextprotocol/registry)
installed:

```
mcp-publisher login github   # device flow: open the URL it prints, enter the code, as flytomoon
mcp-publisher publish        # reads ./server.json
```
