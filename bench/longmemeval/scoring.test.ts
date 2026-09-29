import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { checkInstance, corpusOf, parseSessionDate, retrievalSkipReason, selectInstances } from "./dataset.mjs";
import { dcg, evaluateRetrieval, evaluateRetrievalTurn2Session, ndcg, retrievalMetrics, shownEvidence, summarizeQa, summarizeRetrieval } from "./metrics.mjs";
import { ANSWER_TEMPLATES, CHAIN_OF_NOTE_TEMPLATE, answerPrompt, formatHistory, judgeLabel, judgePrompt, pythonJsonDumps } from "./prompts.mjs";
import { digest, pairwise, report } from "./compare.mjs";
import { instance } from "./fixture.js";

/**
 * SHA-256 of the seven official prompt strings — reader con and direct, the
 * four judge templates by type, and the abstention one — as JSON, computed from
 * the Python sources at 9e0b455 (their string literals evaluated), not from
 * prompts.mjs.
 */
const PROMPTS_SHA256 = "9b986fd842b7d0d7f2b423e8735a4fe00379a960c6648a940500a1800f02e14f";

describe("LongMemEval dataset handling", () => {
  it("reads the dataset's dates as UTC instants and refuses anything else", () => {
    expect(parseSessionDate("2023/05/20 (Sat) 02:21")).toBe("2023-05-20T02:21:00.000Z");
    expect(parseSessionDate("2023/05/20 02:21")).toBe("2023-05-20T02:21:00.000Z");
    expect(() => parseSessionDate("20 May 2023")).toThrow(/Unrecognised/);
    expect(() => parseSessionDate("2023/02/30 (Thu) 10:00")).toThrow(/Invalid/);
  });

  it("names the instance and the field when an instance is not LongMemEval-shaped", () => {
    expect(() => checkInstance(instance(), 0)).not.toThrow();
    expect(() => checkInstance(instance({ question: 7 }), 3)).toThrow("instance 3 (q-city): question must be a string");
    expect(() => checkInstance(instance({ haystack_dates: ["2023/01/05 (Thu) 09:00"] }), 0)).toThrow(/differ in length/);
    const broken = instance();
    (broken.haystack_sessions[1] as unknown[])[0] = { role: "user" };
    expect(() => checkInstance(broken, 0)).toThrow(/session 1 turn 0/);
  });

  it("builds the official turn-level corpus: user turns only, 1-based, 'noans' for evidence-session turns without the evidence", () => {
    const { corpus, correct } = corpusOf(instance());
    expect(corpus.map((c) => c.id)).toEqual(["filler_a1_2", "answer_x1_1_1", "noans_x1_1_3", "answer_x1_2_1"]);
    expect(correct).toEqual(["answer_x1_1_1", "answer_x1_2_1"]);
  });

  it("skips what the official retrieval averages skip: abstention, and no evidence on the user's side", () => {
    expect(retrievalSkipReason(instance())).toBeNull();
    expect(retrievalSkipReason(instance({ question_id: "q-city_abs" }))).toBe("abstention");
    const assistantOnly = instance();
    for (const session of assistantOnly.haystack_sessions) for (const turn of session as { has_answer?: boolean }[]) delete turn.has_answer;
    expect(retrievalSkipReason(assistantOnly)).toBe("no-user-evidence");
  });

  it("--limit takes every question type in turn, deterministically, in file order", () => {
    const types = ["single-session-user", "single-session-user", "single-session-user", "multi-session", "multi-session", "knowledge-update"];
    const all = types.map((t, i) => ({ question_id: `q${i}`, question_type: t }));
    expect(selectInstances(all, { limit: 3 }).map((x) => x.question_id)).toEqual(["q0", "q3", "q5"]);
    expect(selectInstances(all, { limit: 5 }).map((x) => x.question_id)).toEqual(["q0", "q1", "q3", "q4", "q5"]);
    expect(selectInstances(all, { limit: 2, types: ["multi-session"] }).map((x) => x.question_id)).toEqual(["q3", "q4"]);
    expect(selectInstances(all, {})).toHaveLength(6);
  });

  it("--types runs only the types named, and refuses one that does not exist rather than quietly running none of it", () => {
    const types = ["single-session-user", "multi-session", "knowledge-update", "multi-session", "temporal-reasoning"];
    const all = types.map((t, i) => ({ question_id: `q${i}`, question_type: t }));
    expect(selectInstances(all, { types: ["multi-session", "knowledge-update"] }).map((x) => x.question_id)).toEqual(["q1", "q2", "q3"]);
    expect(() => selectInstances(all, { types: ["multi-session", "multisession"] })).toThrow(/Unknown question type "multisession" \(have: single-session-user/);
  });
});

describe("LongMemEval retrieval metrics — eval_utils.py, ported", () => {
  const corpus = ["filler_a1_2", "answer_x1_1_1", "noans_x1_1_3", "answer_x1_2_1"];
  const correct = ["answer_x1_1_1", "answer_x1_2_1"];
  const ranked = ["noans_x1_1_3", "answer_x1_2_1", "filler_a1_2", "answer_x1_1_1"];

  it("discounts as the official dcg does: the first two positions both count in full", () => {
    expect(dcg([1, 1, 1], 3)).toBeCloseTo(1 + 1 + 1 / Math.log2(3));
    expect(dcg([], 3)).toBe(0);
    expect(ndcg(ranked, correct, corpus, 3)).toBeCloseTo(0.5);
    expect(ndcg(ranked, correct, corpus, 4)).toBeCloseTo(0.75);
  });

  it("recall_any and recall_all at k count only what is in the first k", () => {
    expect(evaluateRetrieval(ranked, correct, corpus, 1)).toEqual({ recallAny: 0, recallAll: 0, ndcgAny: 0 });
    expect(evaluateRetrieval(ranked, correct, corpus, 3)).toMatchObject({ recallAny: 1, recallAll: 0 });
    expect(evaluateRetrieval(ranked, correct, corpus, 4)).toMatchObject({ recallAny: 1, recallAll: 1 });
    // A ranking that stops early simply did not retrieve the rest.
    expect(evaluateRetrieval(["answer_x1_1_1"], correct, corpus, 50)).toMatchObject({ recallAny: 1, recallAll: 0 });
  });

  it("session level from a turn ranking: turn ids lose their suffix and k grows until k sessions are covered", () => {
    const turns = ["s1_1", "s1_3", "s2_1", "answer_s3_1"];
    const order = ["s1_1", "s1_3", "answer_s3_1", "s2_1"];
    expect(evaluateRetrieval(order, ["answer_s3_1"], turns, 2).recallAny).toBe(0);
    expect(evaluateRetrievalTurn2Session(order, ["answer_s3_1"], turns, 2).recallAny).toBe(1);
    // A 'noans' turn of an evidence session does not count as finding that session.
    expect(evaluateRetrievalTurn2Session(ranked, correct, corpus, 1)).toMatchObject({ recallAny: 0 });
    expect(evaluateRetrievalTurn2Session(ranked, correct, corpus, 2)).toMatchObject({ recallAny: 1, recallAll: 0 });
  });

  it("gives the numbers the official eval_utils.py gives, on 40 random rankings at every k and both levels", () => {
    // Generated by official-metrics.py, which runs the official code; see that file to regenerate.
    const cases = JSON.parse(readFileSync(join(import.meta.dirname, "fixture-official-metrics.json"), "utf8")) as {
      corpus: string[];
      correct: string[];
      ranked: string[];
      official: Record<string, [number, number, number]>;
    }[];
    expect(cases).toHaveLength(40);
    for (const c of cases) {
      for (const k of [1, 3, 5, 10, 30, 50]) {
        const t = evaluateRetrieval(c.ranked, c.correct, c.corpus, k);
        const s = evaluateRetrievalTurn2Session(c.ranked, c.correct, c.corpus, k);
        expect([t.recallAny, t.recallAll, t.ndcgAny].map((x, i) => x - c.official[`turn@${k}`]![i]!).every((d) => Math.abs(d) < 1e-12)).toBe(true);
        expect([s.recallAny, s.recallAll, s.ndcgAny].map((x, i) => x - c.official[`session@${k}`]![i]!).every((d) => Math.abs(d) < 1e-12)).toBe(true);
      }
    }
  });

  it("reports every official k at both levels, and averages only the questions the official script counts", () => {
    const m = retrievalMetrics(ranked, correct, corpus);
    expect(Object.keys(m.turn)).toHaveLength(18);
    expect(m.session["recall_all@50"]).toBe(1);
    const summary = summarizeRetrieval([
      { question_id: "a", retrieval: { skipped: null, metrics: m } },
      { question_id: "b", retrieval: { skipped: null, metrics: retrievalMetrics([], correct, corpus) } },
      { question_id: "c_abs", retrieval: { skipped: "abstention" } },
    ]);
    expect(summary.questions).toBe(2);
    expect(summary.skipped).toEqual({ abstention: 1, "no-user-evidence": 0 });
    expect(summary.turn["recall_any@3"]).toBe(0.5);
    expect(summary).not.toHaveProperty("shown");
  });

  it("beside them, not among them: how much of the evidence the reader was shown, overall and per type", () => {
    expect(shownEvidence(["noans_x1_1_3", "answer_x1_2_1"], correct)).toEqual({ rounds: 2, evidence: 2, found: 1, all: 0 });
    expect(shownEvidence(ranked, correct)).toEqual({ rounds: 4, evidence: 2, found: 2, all: 1 });
    const m = retrievalMetrics(ranked, correct, corpus);
    const summary = summarizeRetrieval([
      { question_id: "a", question_type: "multi-session", retrieval: { skipped: null, metrics: m, shown: shownEvidence(ranked, correct) } },
      { question_id: "b", question_type: "multi-session", retrieval: { skipped: null, metrics: m, shown: shownEvidence(["answer_x1_2_1"], correct) } },
      { question_id: "c", question_type: "knowledge-update", retrieval: { skipped: null, metrics: m, shown: shownEvidence([], correct) } },
    ]);
    expect(summary.shown).toEqual({
      n: 3,
      allEvidence: 0.3333,
      evidenceFound: 0.5,
      meanRounds: 1.6667,
      byType: {
        "multi-session": { n: 2, allEvidence: 0.5, evidenceFound: 0.75, meanRounds: 2.5 },
        "knowledge-update": { n: 1, allEvidence: 0, evidenceFound: 0, meanRounds: 0 },
      },
    });
    // The official averages are the same with or without it.
    expect(summary.turn).toEqual(summarizeRetrieval([1, 2, 3].map((i) => ({ question_id: `${i}`, retrieval: { skipped: null, metrics: m } }))).turn);
  });
});

describe("compare.mjs — an A/B, question by question", () => {
  const result = (labels: Record<string, [string, boolean]>, judge = "sonnet") => ({
    judge: { requestedModel: judge },
    settings: {},
    questions: Object.entries(labels).map(([id, [type, label]]) => ({ question_id: id, question_type: type, label })),
    summary: { qa: summarizeQa(Object.entries(labels).map(([id, [type, label]]) => ({ question_id: id, question_type: type, label }))), retrieval: {} },
  });

  it("counts what an option fixed and broke against the baseline, per type, over the questions both judged", () => {
    const base = digest(result({ a: ["multi-session", false], b: ["multi-session", true], c: ["knowledge-update", false], d: ["knowledge-update", true] }), "base");
    const option = digest(result({ a: ["multi-session", true], b: ["multi-session", false], c: ["knowledge-update", true], e: ["knowledge-update", true] }), "option");
    expect(pairwise(base, option)).toEqual({
      both: 3,
      fixed: 2,
      broken: 1,
      byType: { "multi-session": { fixed: 1, broken: 1, n: 2 }, "knowledge-update": { fixed: 1, broken: 0, n: 1 } },
    });
    const text = report([base, option]);
    expect(text).toContain("option vs base: fixed 2, broke 1, net +1 of 3  [only 3 questions judged in both]");
  });

  it("says so when the judges differ", () => {
    const text = report([digest(result({ a: ["multi-session", true] }), "base"), digest(result({ a: ["multi-session", true] }, "opus"), "other")]);
    expect(text).toContain("[judge opus vs sonnet]");
  });
});

describe("LongMemEval QA metrics — print_qa_metrics.py, ported", () => {
  it("per type, task-averaged over the types present, overall, and abstention", () => {
    const rows = [
      { question_id: "1", question_type: "multi-session", label: true },
      { question_id: "2", question_type: "multi-session", label: false },
      { question_id: "3", question_type: "multi-session", label: false },
      { question_id: "4_abs", question_type: "knowledge-update", label: true },
      { question_id: "5", question_type: "knowledge-update" }, // not judged
    ];
    const s = summarizeQa(rows);
    expect(s.questions).toBe(4);
    expect(s.overallAccuracy).toBe(0.5);
    expect(s.taskAveragedAccuracy).toBe(0.6667); // (1/3 + 1) / 2, rounded once
    expect(s.byType["multi-session"]).toEqual({ accuracy: 0.3333, n: 3 });
    expect(s.abstention).toEqual({ accuracy: 1, n: 1 });
    expect(s.typesMissing).toContain("temporal-reasoning");
  });
});

describe("LongMemEval prompts — the official strings", () => {
  /**
   * Copied verbatim from the LongMemEval repository at 9e0b455 (prompts.mjs
   * says where). A number is only a LongMemEval number while these are
   * unchanged, so any edit — even whitespace — fails here and has to be
   * explained in the result file.
   */
  it("are byte-for-byte the strings copied from the official code", () => {
    const judge = ["single-session-user", "temporal-reasoning", "knowledge-update", "single-session-preference"].map((t) => judgePrompt(t, "{}", "{}", "{}", false));
    const all = JSON.stringify([ANSWER_TEMPLATES.con, ANSWER_TEMPLATES.direct, ...judge, judgePrompt("multi-session", "{}", "{}", "{}", true)]);
    expect(createHash("sha256").update(all).digest("hex")).toBe(PROMPTS_SHA256);
  });

  it("prints history JSON the way Python's json.dumps does", () => {
    expect(pythonJsonDumps([{ role: "user", content: 'café "x"\n' }])).toBe('[{"role": "user", "content": "caf\\u00e9 \\"x\\"\\n"}]');
    expect(pythonJsonDumps("😀")).toBe('"\\ud83d\\ude00"');
    expect(pythonJsonDumps({ a: [1, true, null] })).toBe('{"a": [1, true, null]}');
  });

  it("builds the reader prompt exactly: rounds sorted by date, numbered as sessions, the con template by default", () => {
    const later = { id: "answer_x1_2_1", date: "2023/05/20 (Sat) 02:21", turns: [{ role: "user", content: "Berlin now." }] };
    const earlier = { id: "answer_x1_1_1", date: "2023/02/10 (Fri) 18:30", turns: [{ role: "user", content: "Tokyo." }, { role: "assistant", content: "Nice!" }] };
    const history =
      '\n### Session 1:\nSession Date: 2023/02/10 (Fri) 18:30\nSession Content:\n\n[{"role": "user", "content": "Tokyo."}, {"role": "assistant", "content": "Nice!"}]\n' +
      '\n### Session 2:\nSession Date: 2023/05/20 (Sat) 02:21\nSession Content:\n\n[{"role": "user", "content": "Berlin now."}]\n';
    expect(formatHistory([later, earlier])).toBe(history);
    const prompt = answerPrompt(instance(), [later, earlier]);
    expect(prompt).toBe(ANSWER_TEMPLATES.con.replace("{}", history).replace("{}", "2023/06/01 (Thu) 10:00").replace("{}", "What city did I move to for work?"));
    expect(prompt.endsWith("Question: What city did I move to for work?\nAnswer (step by step):")).toBe(true);
    expect(answerPrompt(instance(), [], "direct").endsWith("\nAnswer:")).toBe(true);
    expect(() => answerPrompt(instance(), [], "summarise")).toThrow(/Unknown reading method/);
  });

  it("the chain-of-note reader (not official) keeps the official frame and history, and asks for dated notes before the answer", () => {
    const later = { id: "answer_x1_2_1", date: "2023/05/20 (Sat) 02:21", turns: [{ role: "user", content: "Berlin now." }] };
    const earlier = { id: "answer_x1_1_1", date: "2023/02/10 (Fri) 18:30", turns: [{ role: "user", content: "Tokyo." }] };
    const prompt = answerPrompt(instance(), [later, earlier], "chain-of-note");
    expect(CHAIN_OF_NOTE_TEMPLATE.match(/\{\}/g)).toHaveLength(3);
    expect(prompt.startsWith("I will give you several history chats between you and a user. Please answer the question based on the relevant chat history.")).toBe(true);
    expect(prompt).toContain(`History Chats:\n\n${formatHistory([later, earlier])}\n\nCurrent Date: 2023/06/01 (Thu) 10:00\nQuestion: What city did I move to for work?\n`);
    expect(prompt).toMatch(/Step 1, notes\..*the session date/);
    expect(prompt).toMatch(/Step 2, answer\..*Count a thing once/);
    expect(prompt.endsWith("Answer (notes first, then the answer):")).toBe(true);
    // Not one of the official templates, and they are unchanged by it.
    expect(Object.keys(ANSWER_TEMPLATES)).toEqual(["con", "direct"]);
  });

  it("chooses the judge template by question type, and the abstention one for _abs questions", () => {
    expect(judgePrompt("knowledge-update", "Q", "Berlin", "R", false)).toContain("the updated answer is the required answer");
    expect(judgePrompt("temporal-reasoning", "Q", 18, "R", false)).toContain("do not penalize off-by-one errors");
    expect(judgePrompt("temporal-reasoning", "Q", 18, "R", false)).toContain("Correct Answer: 18\n");
    expect(judgePrompt("single-session-preference", "Q", "rubric", "R", false)).toContain("Rubric: rubric");
    expect(judgePrompt("multi-session", "Q", "A", "R", true)).toContain("correctly identifies the question as unanswerable");
    expect(judgePrompt("single-session-user", "Q", "A", "R", false)).toMatch(/^I will give you a question, a correct answer, and a response from a model\./);
    expect(() => judgePrompt("open-domain", "Q", "A", "R", false)).toThrow(/No official judge prompt/);
  });

  it("labels a verdict exactly as the official script: 'yes' anywhere, case-insensitive", () => {
    expect(judgeLabel("Yes.")).toBe(true);
    expect(judgeLabel(" no ")).toBe(false);
    expect(judgeLabel("No, but yes in part")).toBe(true);
  });
});
