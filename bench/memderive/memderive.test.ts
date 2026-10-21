import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import * as lib from "../../src/index.js";
import { REPO_ROOT } from "../lib/run-info.mjs";
import {
  Bm25Index,
  FAMILIES,
  MAX_CONSECUTIVE_FAILURES,
  buildStore,
  checkCases,
  compare,
  fillerFrom,
  itemsOf,
  loadCases,
  makeRankers,
  plainTokens,
  questionsOf,
  runQuestions,
  scoreRanking,
  stemmedTokens,
  summarize,
} from "./memderive.mjs";
import { porterStem } from "./porter.mjs";

/** Two subjects: a count over three events and a value that changed twice. */
const tiny = () => ({
  now: "2026-09-01T00:00:00.000Z",
  subjects: [
    {
      id: "books",
      events: [
        { id: "b1", at: "2026-01-01", text: "Finished reading Dune." },
        { id: "b2", at: "2026-02-01", text: "Finished reading Emma." },
        { id: "b3", at: "2026-03-01", text: "Wrapped up Piranesi." },
      ],
      distractors: [{ id: "bd", at: "2026-04-01", text: "Bought a bookshelf." }],
      questions: [{ id: "books-count", family: "count", text: "How many books have I finished reading?", needs: ["b1", "b2", "b3"] }],
    },
    {
      id: "gym",
      events: [
        { id: "g1", at: "2025-10-01", text: "I go to the YMCA gym." },
        { id: "g2", at: "2026-05-01", text: "I go to the CrossFit gym now." },
      ],
      questions: [{ id: "gym-now", family: "latest", text: "Which gym do I go to?", needs: ["g2"], supersedes: { g2: ["g1"] } }],
    },
  ],
});

describe("memderive dataset", () => {
  it("the committed cases are well-formed, use every family, and bench/README.md counts them right", () => {
    const cases = loadCases(join(REPO_ROOT, "bench", "memderive", "cases.json"));
    const questions = questionsOf(cases);
    expect(new Set(questions.map((q: { family: string }) => q.family))).toEqual(new Set(FAMILIES));
    const readme = readFileSync(join(REPO_ROOT, "bench", "README.md"), "utf8").replace(/\s+/g, " ");
    const items = itemsOf(cases);
    expect(readme).toContain(`${questions.length} questions in ${FAMILIES.length} families`);
    expect(readme).toContain(`over ${items.filter((i: { kind: string }) => i.kind === "event").length} events said by one person`);
    expect(readme).toContain(`with ${items.filter((i: { kind: string }) => i.kind === "distractor").length} near-miss distractors`);
    expect(readme).toContain(`${questions.length} questions: one question is ${(100 / questions.length).toFixed(1)} points`);
  });

  it("refuses duplicate ids, dates after now, unknown families, and needs that are not events", () => {
    expect(() => checkCases(tiny())).not.toThrow();
    const dup = tiny();
    dup.subjects[1]!.events[0]!.id = "b1";
    expect(() => checkCases(dup)).toThrow(/duplicate id b1/);
    const late = tiny();
    late.subjects[0]!.events[0]!.at = "2027-01-01";
    expect(() => checkCases(late)).toThrow(/after now/);
    const family = tiny();
    family.subjects[0]!.questions[0]!.family = "vibes";
    expect(() => checkCases(family)).toThrow(/unknown family/);
    const distractor = tiny();
    distractor.subjects[0]!.questions[0]!.needs = ["bd"];
    expect(() => checkCases(distractor)).toThrow(/not an event/);
    const both = tiny();
    both.subjects[1]!.questions[0]!.supersedes = { g2: ["g2"] };
    expect(() => checkCases(both)).toThrow(/both needed and superseded/);
  });
});

describe("Porter stemmer", () => {
  it("stems the paper's examples as the reference implementation does", () => {
    const pairs: [string, string][] = [
      ["caresses", "caress"], ["ponies", "poni"], ["cats", "cat"], ["feed", "feed"], ["agreed", "agre"],
      ["plastered", "plaster"], ["bled", "bled"], ["motoring", "motor"], ["sing", "sing"], ["conflated", "conflat"],
      ["troubled", "troubl"], ["sized", "size"], ["hopping", "hop"], ["tanned", "tan"], ["falling", "fall"],
      ["hissing", "hiss"], ["fizzed", "fizz"], ["failing", "fail"], ["filing", "file"], ["happy", "happi"],
      ["sky", "sky"], ["relational", "relat"], ["conditional", "condit"], ["hopefulness", "hope"], ["goodness", "good"],
      ["adjustment", "adjust"], ["adoption", "adopt"], ["generalizations", "gener"], ["oscillators", "oscil"],
      ["replacement", "replac"], ["controlling", "control"], ["rate", "rate"], ["cease", "ceas"], ["moved", "move"],
      ["running", "run"], ["finished", "finish"], ["migraines", "migrain"], ["flights", "flight"], ["by", "by"],
    ];
    for (const [word, stem] of pairs) expect([word, porterStem(word)]).toEqual([word, stem]);
  });
});

describe("BM25 baseline", () => {
  it("tokenises like unicode61, and the stemmed analyzer drops stopwords and possessives", () => {
    expect(plainTokens("Maya's practice, on Tuesdays!")).toEqual(["maya", "s", "practice", "on", "tuesdays"]);
    expect(stemmedTokens("Maya's practice is on Tuesdays")).toEqual(["maya", "practic", "tuesdai"]);
  });

  it("scores Okapi BM25 by hand, ranks ties by document order, and never returns a document matching nothing", () => {
    const docs = [
      { id: "a", text: "red apple" },
      { id: "b", text: "red red red car" },
      { id: "c", text: "green pear" },
      { id: "d", text: "red apple" },
    ];
    const index = new Bm25Index(docs, plainTokens);
    // idf(apple) = ln(1 + (4 - 2 + 0.5) / (2 + 0.5)) = ln 2; doc a: tf 1, length 2, average length 10 / 4.
    const norm = 1.2 * (1 - 0.75 + (0.75 * 2) / 2.5);
    expect(index.idf("apple")).toBeCloseTo(Math.log(2), 12);
    expect(index.scores("apple").get(0)).toBeCloseTo((Math.log(2) * 1 * 2.2) / (1 + norm), 12);
    // doc b: tf 3, length 4; idf(red) = ln(1 + 1.5 / 3.5).
    const normB = 1.2 * (1 - 0.75 + (0.75 * 4) / 2.5);
    expect(index.scores("red").get(1)).toBeCloseTo((Math.log(1 + 1.5 / 3.5) * 3 * 2.2) / (3 + normB), 12);
    expect(index.search("apple", 10)).toEqual(["a", "d"]);
    expect(index.search("red", 10)[0]).toBe("b");
    expect(index.search("banana", 10)).toEqual([]);
    expect(index.search("red apple", 2)).toEqual(["a", "d"]);
  });
});

describe("scoring", () => {
  const [count, latest] = questionsOf(tiny());

  it("counts a question answerable at k only when every needed event is in the first k", () => {
    const s = scoreRanking(["b1", "x", "b2", "b3"], count, [3, 4]);
    expect(s[3]).toEqual({ full: false, recall: 2 / 3 });
    expect(s[4]).toEqual({ full: true, recall: 1 });
  });

  it("currentFirst needs the replacing value present and above every value it replaced", () => {
    expect(scoreRanking(["g2", "g1"], latest, [5])[5]!.currentFirst).toBe(true);
    expect(scoreRanking(["g1", "g2"], latest, [5])[5]!.currentFirst).toBe(false);
    expect(scoreRanking(["g1"], latest, [5])[5]!.currentFirst).toBe(false);
    expect(scoreRanking(["x", "g2"], latest, [5])[5]!.currentFirst).toBe(true);
  });

  it("records a failed recall with its own message, and stops after three failures in a row", async () => {
    const questions = [...questionsOf(tiny()), ...questionsOf(tiny()).map((q: { id: string }) => ({ ...q, id: `${q.id}-again` }))];
    let calls = 0;
    const run = await runQuestions(questions, {
      good: async () => ["b1", "b2", "b3", "g2"],
      bad: async () => {
        calls += 1;
        throw new Error(`boom ${calls}`);
      },
    });
    expect(run.rows.find((r: { system: string; error?: string }) => r.system === "bad")?.error).toBe("boom 1");
    // good/bad alternate, so failures never come three in a row: every unit runs.
    expect(run).toMatchObject({ attempted: 8, succeeded: 4, failed: 4, aborted: null });

    const broken = await runQuestions(questions, { bad: async () => Promise.reject(new Error("down")) });
    expect(broken).toMatchObject({ attempted: MAX_CONSECUTIVE_FAILURES, succeeded: 0, failed: MAX_CONSECUTIVE_FAILURES });
    expect(broken.aborted).toMatch(/stopped after 3 failures in a row .*down/);
  });

  it("summarises per family and compares two systems question by question", async () => {
    const questions = questionsOf(tiny());
    const run = await runQuestions(questions, { a: async () => ["b1", "b2", "b3", "g2"], b: async () => ["g2", "b1"] }, { ks: [5] });
    const summary = summarize(run.rows, ["a", "b"], [5]);
    expect(summary.a.all).toMatchObject({ n: 2, 5: { full: 1, currentFirst: 1, currentFirstN: 1 } });
    expect(summary.b.count[5]).toMatchObject({ full: 0, recall: 0.3333 });
    expect(compare(run.rows, "a", "b", 5)).toEqual({ a: "a", b: "b", k: 5, wins: ["books-count"], losses: [] });
  });
});

describe("filler", () => {
  const instances = [
    { haystack_sessions: [[{ role: "user", content: "I have been thinking about planting a vegetable garden this spring." }, { role: "assistant", content: "Great idea, here is how to start a garden." }]] },
    { haystack_sessions: [[{ role: "user", content: "I have been thinking about planting a vegetable garden this spring." }, { role: "user", content: "short" }, { role: "user", content: "Can you suggest a few podcasts about the history of Rome?" }]] },
  ];

  it("takes distinct user turns only, deterministically, dated across the span", () => {
    const a = fillerFrom(instances, { count: 2, seed: 7, from: "2026-01-01", to: "2026-03-01T00:00:00.000Z" });
    expect(a.map((f: { text: string }) => f.text).sort()).toEqual([
      "Can you suggest a few podcasts about the history of Rome?",
      "I have been thinking about planting a vegetable garden this spring.",
    ]);
    expect(fillerFrom(instances, { count: 2, seed: 7, from: "2026-01-01", to: "2026-03-01T00:00:00.000Z" })).toEqual(a);
    expect(a.map((f: { at: string }) => f.at)).toEqual(["2026-01-01T00:00:00.000Z", "2026-01-30T12:00:00.000Z"]);
    expect(() => fillerFrom(instances, { count: 3, from: "2026-01-01", to: "2026-03-01" })).toThrow(/has 2 that qualify/);
    expect(fillerFrom(instances, { count: 0, from: "2026-01-01", to: "2026-03-01" })).toEqual([]);
  });
});

describe("end to end on the source library", () => {
  it("stores every item, ranks with every keyword system, and skips hybrid recall without an embedder, saying why", async () => {
    const cases = tiny();
    const items = itemsOf(cases);
    const store = await buildStore(lib, items);
    try {
      const { rankers, skipped } = makeRankers(lib, store, items, { now: cases.now });
      expect(Object.keys(rankers)).toEqual(["al-buddy-keyword", "fts", "bm25", "bm25-stem"]);
      expect(skipped["al-buddy"]).toMatch(/needs an embedder/);
      const run = await runQuestions(questionsOf(cases), rankers);
      expect(run).toMatchObject({ attempted: 8, succeeded: 8, aborted: null });
      for (const row of run.rows) expect(row.ranked.length).toBeGreaterThan(0);
      // The two events that share "finished reading" with the question come first; "Wrapped up Piranesi" shares no word.
      const fts = run.rows.find((r: { system: string; question: string }) => r.system === "fts" && r.question === "books-count");
      expect(fts.ranked.slice(0, 2).sort()).toEqual(["b1", "b2"]);
    } finally {
      store.close();
    }
  });
});
