import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RESULTS_DIR } from "../lib/run-info.mjs";
import { digest, evidencePairs, report } from "./compare.mjs";
import { PUBLISHED, answeredSummary, pairProblems, publishedSets, resultSentence, retrievalVerdict } from "./event-study.mjs";

type Shown = { found: number; evidence: number };
/** A retrieval-only result file: `shown` maps id → [type, found, evidence]. */
function result(shown: Record<string, [string, number, number]>, { events = false, errors = 0, labels = {} as Record<string, boolean>, extraction = { sessions: 1000, failed: [] as unknown[] } } = {}) {
  const questions = Object.entries(shown).map(([id, [type, found, evidence]]) => ({
    question_id: id,
    question_type: type,
    retrieval: { skipped: null, shown: { rounds: 20, evidence, found, all: found === evidence ? 1 : 0 } satisfies Shown & Record<string, number> },
    shownRounds: [],
    ...(id in labels ? { label: labels[id] } : {}),
  }));
  const byType: Record<string, { accuracy: number; n: number }> = {};
  for (const q of questions) if ("label" in q) {
    const t = (byType[q.question_type] ??= { accuracy: 0, n: 0 });
    t.accuracy = (t.accuracy * t.n + (q.label ? 1 : 0)) / (t.n + 1);
    t.n += 1;
  }
  return {
    commit: "abc",
    dataset: { sha256: "d" },
    settings: { selection: { questions: questions.length }, topK: 20, ingestion: events ? "with events" : "raw", eventExtraction: events ? { model: "sonnet" } : null, concurrency: 4 },
    ...(events ? { eventExtraction: extraction } : {}),
    summary: { questions: questions.length + errors, errors, qa: { byType, overallAccuracy: null, questions: 0 }, retrieval: { shown: null }, recall: null, meanPromptChars: 100 },
    questions,
  };
}

const published = { lostToRecall: [{ id: "g1", type: "multi-session" }, { id: "g2", type: "temporal-reasoning" }], shownAll: ["k1", "k2"], correctByType: {} };

describe("the study's bar", () => {
  it("counts the lost-to-recall questions newly shown every evidence turn, and any the base showed in full that the events arm does not", () => {
    const base = result({ g1: ["multi-session", 1, 3], g2: ["temporal-reasoning", 0, 1], k1: ["multi-session", 2, 2], k2: ["temporal-reasoning", 1, 1], o: ["multi-session", 2, 4] });
    const events = result({ g1: ["multi-session", 3, 3], g2: ["temporal-reasoning", 0, 1], k1: ["multi-session", 1, 2], k2: ["temporal-reasoning", 1, 1], o: ["multi-session", 1, 4] }, { events: true });
    const v = retrievalVerdict(base, events, published);
    expect(v.status).toBe("fail");
    expect(v.bar).toMatchObject({ gained: 1, of: 2, lost: 1, ofShownAllInBase: 2 });
    expect(v.gainSet).toEqual([
      { id: "g1", type: "multi-session", base: "1/3", events: "3/3", newlyShownAll: true },
      { id: "g2", type: "temporal-reasoning", base: "0/1", events: "0/1", newlyShownAll: false },
    ]);
    expect(v.lost).toEqual(["k1"]);
    expect(v.fewerTurns).toEqual(["o"]);
    expect(v.againstPublished).toEqual({ shownAll: 2, shownAllInBase: 2, noLongerShownAllWithEvents: ["k1"] });
    expect(v.byType.base["multi-session"]).toEqual({ scored: 3, all: 1, found: 5, evidence: 9 });
    expect(v.byType.events["multi-session"]).toEqual({ scored: 3, all: 1, found: 5, evidence: 9 });
    expect(resultSentence(v, null, { arms: 2 })).toMatch(/^RESULT: Over 2 types, the events arm newly showed every evidence turn for 1 of the 2 .* stopped showing it for 1 of the 2 .*the bar \(at least 6, and 0\) failed, so the answered pair was not run\.$/);
  });

  it("passes at 6 gained and none lost", () => {
    const ids = ["a", "b", "c", "d", "e", "f"];
    const lost = { lostToRecall: ids.map((id) => ({ id, type: "multi-session" })), shownAll: [], correctByType: {} };
    const base = result(Object.fromEntries(ids.map((id) => [id, ["multi-session", 0, 1]])) as Record<string, [string, number, number]>);
    const events = result(Object.fromEntries(ids.map((id) => [id, ["multi-session", 1, 1]])) as Record<string, [string, number, number]>, { events: true });
    expect(retrievalVerdict(base, events, lost).status).toBe("pass");
  });

  it("is incomplete, not a result, when the arms are not a clean pair", () => {
    const base = result({ g1: ["multi-session", 1, 3], g2: ["temporal-reasoning", 0, 1] });
    const events = result({ g1: ["multi-session", 3, 3], g2: ["temporal-reasoning", 1, 1] }, { events: true, errors: 1, extraction: { sessions: 100, failed: [1, 2] } });
    const v = retrievalVerdict(base, events, published);
    expect(v.status).toBe("incomplete");
    expect(v.incomplete).toEqual(["1 question(s) errored in the events arm", "2 of 100 sessions failed extraction (over 1%)"]);
    expect(resultSentence(v, null, { arms: 2 })).toMatch(/^RESULT: The event study is incomplete \(.*\); it concludes nothing\.$/);
    expect(pairProblems(base, { ...events, commit: "other", settings: { ...events.settings, topK: 10 } })).toEqual(["commits differ (abc vs other)", "settings differ beyond --extract-events"]);
    expect(pairProblems(base, base)).toEqual(["the events arm did not extract events"]);
    const missing = retrievalVerdict(base, result({ g1: ["multi-session", 3, 3] }, { events: true }), published);
    expect(missing.incomplete).toContain("the arms ran different questions");
    expect(missing.incomplete).toContain("1 of the 2 lost-to-recall questions are missing from an arm");
  });

  it("summarises the answered pair per type", () => {
    const base = result({ a: ["multi-session", 1, 1], b: ["multi-session", 1, 1], c: ["temporal-reasoning", 1, 1] }, { labels: { a: false, b: true, c: true } });
    const events = result({ a: ["multi-session", 1, 1], b: ["multi-session", 1, 1], c: ["temporal-reasoning", 1, 1] }, { events: true, labels: { a: true, b: true, c: false } });
    const s = answeredSummary(base, events);
    expect(s).toMatchObject({ base: { "multi-session": { correct: 1, n: 2 }, "temporal-reasoning": { correct: 1, n: 1 } }, events: { "multi-session": { correct: 2, n: 2 } }, fixed: 1, broken: 1 });
    const v = retrievalVerdict(result({ g1: ["multi-session", 0, 1] }), result({ g1: ["multi-session", 1, 1] }, { events: true }), { lostToRecall: [{ id: "g1", type: "multi-session" }], shownAll: [], correctByType: {} });
    expect(resultSentence({ ...v, status: "pass" }, s, { arms: 4 })).toMatch(/answered with the Claude judge, multi-session 1→2 of 2, temporal 1→0 of 1 \(fixed 1, broke 1\)\.$/);
  });
});

describe("compare.mjs pairs retrieval as well as answers", () => {
  it("lists newly shown, no longer shown and fewer-turn questions per type", () => {
    const base = digest(result({ a: ["multi-session", 0, 1], b: ["multi-session", 1, 1], c: ["temporal-reasoning", 2, 3] }));
    const other = digest(result({ a: ["multi-session", 1, 1], b: ["multi-session", 0, 1], c: ["temporal-reasoning", 1, 3] }, { events: true }));
    const p = evidencePairs(base, other);
    expect([p.n, p.gained, p.lost, p.fewer]).toEqual([3, ["a"], ["b"], ["c"]]);
    expect(p.byType["temporal-reasoning"]).toEqual({ n: 1, gained: [], lost: [], fewer: ["c"] });
    expect(report([base, other])).toMatch(/every evidence turn shown: newly in 1, no longer in 1, fewer turns in 1 more \(of 3 scored in both\)/);
  });
});

describe("the published run the study is measured against", () => {
  it("has the 17 lost-to-recall questions and the 223 shown every evidence turn that the review names", () => {
    const sets = publishedSets(
      JSON.parse(readFileSync(join(RESULTS_DIR, PUBLISHED.result), "utf8")),
      readFileSync(join(RESULTS_DIR, PUBLISHED.labels), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)),
    );
    expect(sets.lostToRecall).toHaveLength(17);
    expect(sets.lostToRecall.filter((q) => q.type === "multi-session")).toHaveLength(12);
    expect(sets.shownAll).toHaveLength(223);
    expect(sets.correctByType).toEqual({ "multi-session": { correct: 111, n: 133 }, "temporal-reasoning": { correct: 125, n: 133 } });
  });
});
