/**
 * The OmniMemEval commit this adapter is written against. `harness.mjs`
 * clones it, checks this commit out and refuses any other: a patch anchor
 * that moved upstream must fail loudly, not land in the wrong place.
 */
export const OMNIMEMEVAL = Object.freeze({
  repo: "https://github.com/MemTensor/OmniMemEval.git",
  commit: "ff13e4a5b12e3c406a81c32bb0834c7e8d73f38e",
  /** The commit's own date (docs: split user memory benchmark result details, #24). */
  date: "2026-11-17",
});

/** Our key in OmniMemEval's client registry (`--lib al_buddy`). */
export const LIB = "al_buddy";

/** The shared baseline models of OmniMemEval's Evaluation Setup (docs/user_memory/results.md). */
export const ANSWER_MODEL = "gpt-4.1-mini-2025-04-14";
export const EVAL_MODEL = "gpt-4o-mini-2024-07-18";
