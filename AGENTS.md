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

This repo shows final scores only. bench/results/ holds one result file per
headline number in the README's Benchmarks table, and nothing else
(bench/results-attributes.test.ts lists them). Every other run goes to the
private repo's bench/results-history: the runners write to
`$BENCH_RESULTS_DIR`, else that folder when it is beside this checkout, else
bench/results (bench/README.md, "Where results go"). Don't commit a run here
unless it replaces a headline number.

Result files under bench/results/ (`*.json`, `*.jsonl`) are data, and
.gitattributes marks them `-diff`, so a branch's diff shows them as
"Bin 0 -> N bytes" and stays reviewable. Keep the attribute
(bench/results-attributes.test.ts pins it). `*.summary.json` stays in the
diff.
