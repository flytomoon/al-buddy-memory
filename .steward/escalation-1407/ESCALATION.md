VERDICT: FIXED

The release name scan was right. Three lines in the new
docs/reviews/recall-quality-vs-latency-2026-10.md (§ 6, the source tables) named other
projects. CONTRIBUTING.md says to write against shapes and specs, and that comparisons go
in the README table only.

Changed (docs only, no code):
- "Bi-temporal validity" now cites bitemporal data (SQL:2011) and the temporal
  knowledge-graph memory paper (Rasmussen et al. 2025) instead of the vendor name.
- "ADD-only memory" now cites event sourcing and append-only agent-memory designs (2026).
- "Not now: LLM extraction or consolidation at write" now cites A-Mem (Xu et al. 2025),
  a paper, instead of two product names.

What each row says is unchanged. The recall-step-3 work and its numbers (the #1004 chain)
are untouched.

Checked: the name scan's git grep finds nothing (exit 1, no lines). Typecheck passes
(tsc --noEmit run directly), src/release-script.test.ts passes (26/26), and
tsc -p tsconfig.json passes.
Still owed to the landing: npm ci (spawn EPERM in this sandbox; installed with
--ignore-scripts instead), the full npm run check, and build:demo.
