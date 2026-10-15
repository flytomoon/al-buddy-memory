# Notes for coding agents

Read CONTRIBUTING.md first; its ground rules apply to you too.

## Docs claims

A change to README.md, SECURITY.md, docs/SIGN-IN.md or the consent page text
(`consentPage` in src/mcp/owner-oauth.ts) must add or update an assertion in
src/docs-accuracy.test.ts that pins the claim to code: the test reads the
sentence and checks the code still does what it says. Three findings of the
2026-10-13 review were sentences in these files that the code did not keep.

src/docs-claims-guard.test.ts enforces this: it fails when the branch's
commits since origin/main change one of those files and not
docs-accuracy.test.ts. It skips when git or origin/main is not available.

## Bench results

Result files under bench/results/ (`*.json`, `*.jsonl`) are data, and
.gitattributes marks them `-diff`, so a branch's diff shows them as
"Bin 0 -> N bytes" and stays reviewable. Jobs #1003 and #1004 each committed
1-2 MB sweeps beside their code; the landing review got a 4.8 MB and a 5.6 MB
diff, and both were held at review. Keep the attribute (bench/results-attributes.test.ts
pins it). Put the numbers a reviewer needs in the commit message or the doc
that cites the file, not by pasting result rows. `*.summary.json` stays in
the diff. A branch made before the attribute must merge main before it lands,
or its own diff still carries the rows.
