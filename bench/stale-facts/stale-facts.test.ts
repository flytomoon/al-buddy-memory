import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import * as lib from "../../src/index.js";
import { REPO_ROOT } from "../lib/run-info.mjs";
import { checkCases, expectedAt, ingestionOrder, loadCases, questionsOf, runStrategy, scoreRanking, summarizeStrategy } from "./stale-facts.mjs";

/**
 * One subject that changes twice, an old fact told late, and one distractor.
 * The three statements are worded alike, so keyword relevance ties and only
 * validity and recency tell them apart.
 */
const tiny = () => ({
  now: "2026-09-01T00:00:00.000Z",
  subjects: [
    {
      id: "home",
      subject: "me",
      aspect: "home city",
      statements: [
        { id: "lisbon", at: "2018-01-01", learnedLate: true, text: "I live in Lisbon." },
        { id: "london", at: "2021-01-01", text: "I live in London." },
        { id: "berlin", at: "2025-01-01", text: "I live in Berlin." },
      ],
      questions: [{ text: "Where do I live?" }, { text: "Where did I live in 2022?", asOf: "2022-06-01" }],
    },
  ],
  distractors: [{ at: "2024-01-01", text: "My sister lives in Madrid." }],
});

describe("stale-facts dataset", () => {
  it("the committed cases are well-formed, and bench/README.md counts them right", () => {
    const cases = loadCases(join(REPO_ROOT, "bench", "stale-facts", "cases.json"));
    expect(questionsOf(cases).some((q) => q.kind === "as-of" && q.lateArrival)).toBe(true);
    const changing = cases.subjects.filter((s: { statements: unknown[] }) => s.statements.length > 1).length;
    const late = cases.subjects.filter((s: { statements: { learnedLate?: boolean }[] }) => s.statements.some((st) => st.learnedLate)).length;
    const readme = readFileSync(join(REPO_ROOT, "bench", "README.md"), "utf8").replace(/\s+/g, " ");
    expect(readme).toContain(`${changing} things about a person that change over time`);
    expect(readme).toContain(`and ${cases.subjects.length - changing} that do not`);
    expect(readme).toContain(`with ${cases.distractors.length} unrelated facts`);
    expect(readme).toContain(`${late} of the changes include an old fact told late`);
  });

  it("the README's table is the committed result it links to, from a clean tree and this dataset", () => {
    const readme = readFileSync(join(REPO_ROOT, "README.md"), "utf8").replace(/\s+/g, " ");
    const file = readme.match(/\]\((bench\/results\/\d{4}-\d{2}-\d{2}-stale-facts(?:-\d+)?\.json)\)/)?.[1];
    expect(file).toBeDefined();
    const result = JSON.parse(readFileSync(join(REPO_ROOT, file!), "utf8"));
    const cases = loadCases(join(REPO_ROOT, "bench", "stale-facts", "cases.json"));
    expect(result).toMatchObject({ dirty: false, settings: { k: 5, retrieval: "keyword" }, dataset: { version: cases.version, subjects: cases.subjects.length, distractors: cases.distractors.length } });
    const { now, asOf } = result.summary["current-state"];
    expect(readme).toContain(`${now.n} questions about now, ${asOf.n} about a past instant; keyword recall, no embedder; first 5 results`);
    const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
    const row = (label: string, slice: string, metric: string) =>
      `| ${label} | ${["append-only", "append-only+freshness", "current-state"].map((s) => pct(result.summary[s][slice][metric])).join(" | ")} |`;
    for (const [label, slice, metric] of [
      ["Now: an outdated value comes first", "now", "staleAt1"],
      ["Now: an outdated value in the first 5", "now", "staleInTopK"],
      ["Now: the current value comes first", "now", "currentAt1"],
      ["Then: a value not true then in the first 5", "asOf", "staleInTopK"],
      ["Then: the value true then comes first", "asOf", "currentAt1"],
    ] as const) {
      expect(readme).toContain(row(label, slice, metric));
    }
  });

  it("refuses duplicate ids, dates after now, and a question asked before its subject had any value", () => {
    const dup = tiny();
    dup.subjects[0]!.statements[1]!.id = "lisbon";
    expect(() => checkCases(dup)).toThrow(/duplicate statement id lisbon/);
    const future = tiny();
    future.subjects[0]!.statements[2]!.at = "2027-01-01";
    expect(() => checkCases(future)).toThrow(/after now/);
    const early = tiny();
    early.subjects[0]!.questions.push({ text: "Where did I live in 2010?", asOf: "2010-01-01" });
    expect(() => checkCases(early)).toThrow(/nothing is true yet/);
  });

  it("the true statement at an instant is the latest one begun at or before it, told late or not", () => {
    const [home] = tiny().subjects;
    expect(expectedAt(home, "2026-09-01T00:00:00.000Z")!.id).toBe("berlin");
    expect(expectedAt(home, "2022-06-01T00:00:00.000Z")!.id).toBe("london");
    expect(expectedAt(home, "2019-06-01T00:00:00.000Z")!.id).toBe("lisbon");
    expect(expectedAt(home, "2017-06-01T00:00:00.000Z")).toBeNull();
  });

  it("the memory hears everything by date, then what was told late", () => {
    expect(ingestionOrder(tiny()).map((x) => x.statement?.id ?? x.id)).toEqual(["london", "distractor-1", "berlin", "lisbon"]);
  });

  it("every other statement of the subject is wrong at that instant — older and newer alike", () => {
    const [now, then] = questionsOf(tiny());
    expect(now).toMatchObject({ kind: "now", expected: "berlin", wrong: ["lisbon", "london"], lateArrival: true });
    expect(then).toMatchObject({ kind: "as-of", validAt: "2022-06-01T00:00:00.000Z", expected: "london", wrong: ["lisbon", "berlin"] });
  });

  it("scores a ranking by statement identity", () => {
    const q = { expected: "berlin", wrong: ["london", "lisbon"] };
    expect(scoreRanking(["berlin", "distractor-1"], q, 5)).toEqual({ currentAt1: true, staleAt1: false, currentInTopK: true, staleInTopK: false, cleanTopK: true });
    expect(scoreRanking(["london", "berlin"], q, 5)).toEqual({ currentAt1: false, staleAt1: true, currentInTopK: true, staleInTopK: true, cleanTopK: false });
    expect(scoreRanking(["distractor-1", "london", "berlin"], q, 2)).toEqual({ currentAt1: false, staleAt1: false, currentInTopK: false, staleInTopK: true, cleanTopK: false });
    expect(summarizeStrategy([{ kind: "now", lateArrival: false, ...scoreRanking(["berlin"], q, 5) }]).now).toEqual({ n: 1, currentAt1: 1, staleAt1: 0, currentInTopK: 1, staleInTopK: 0, cleanTopK: 1 });
  });
});

describe("stale-facts strategies — the same statements, three ways", () => {
  it("append-only keeps every old value where recall can find it", async () => {
    const [now] = await runStrategy(lib, tiny(), "append-only", { k: 5 });
    expect(now!.ranked).toEqual(expect.arrayContaining(["berlin", "london"]));
    expect(now!.staleInTopK).toBe(true);
  });

  it("freshness favours what was learned last — so an old fact told late wins", async () => {
    const [now] = await runStrategy(lib, tiny(), "append-only+freshness", { k: 5 });
    expect(now!.ranked[0]).toBe("lisbon");
    expect(now!.staleAt1).toBe(true);
  });

  it("recordState returns only the current value now, a late old fact never overturns it, and a past instant never sees the future", async () => {
    const [now, then] = await runStrategy(lib, tiny(), "current-state", { k: 5 });
    expect(now!.ranked.filter((id) => id !== "distractor-1")).toEqual(["berlin"]);
    expect(now!.cleanTopK).toBe(true);
    expect(then!.ranked).toContain("london");
    expect(then!.ranked).not.toContain("berlin");
  });
});
