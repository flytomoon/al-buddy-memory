import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import * as lib from "../../src/index.js";
import { UsageLimitError } from "../longmemeval/answerers.mjs";
import { loadAuditKey, loadConversations, parseLocomoDate, readConversation, resolveEvidence, selectQuestions } from "./dataset.mjs";
import { ensureFiles, fileUrls, localPath } from "./download.mjs";
import { evaluateQuestion, recallConversation, runLocomo } from "./harness.mjs";
import { scoreTable, summarize } from "./metrics.mjs";
import { JUDGE_SYSTEM, READING_TEMPLATES, adversarialJudgePrompt, answerPrompt, formatContext, judgeLabel, judgePrompt, keywordRule } from "./prompts.mjs";

/** A LoCoMo-shaped sample: three sessions with turns (numbered out of order on purpose), one with a date and no turns. */
function sample() {
  return {
    sample_id: "conv-x",
    conversation: {
      speaker_a: "Ana",
      speaker_b: "Ben",
      session_1_date_time: "1:56 pm on 8 May, 2023",
      session_1: [
        { speaker: "Ana", dia_id: "D1:1", text: "I adopted a puppy named Biscuit yesterday." },
        { speaker: "Ben", dia_id: "D1:2", text: "Congrats! I ran a charity race last Saturday." },
        { speaker: "Ana", dia_id: "D1:3", text: "Look at this", blip_caption: "a photo of a dog on a beach" },
      ],
      session_10_date_time: "8:00 pm on 1 August, 2023",
      session_10: [{ speaker: "Ana", dia_id: "D10:1", text: "We moved to Lisbon last week." }],
      session_2_date_time: "10:37 am on 27 June, 2023",
      session_2: [
        { speaker: "Ben", dia_id: "D2:1", text: "I started learning the violin." },
        { speaker: "Ana", dia_id: "D2:2", text: "Biscuit learned to sit!" },
      ],
      session_3_date_time: "9:00 am on 2 July, 2023",
    },
    qa: [
      { question: "What is the name of Ana's puppy?", answer: "Biscuit", evidence: ["D1:1"], category: 4 },
      { question: "When did Ben run a charity race?", answer: "The Saturday before 8 May 2023", evidence: ["D1:2"], category: 2 },
      { question: "What year did Ana move to Lisbon?", answer: 2023, evidence: ["D10:01; D2:9"], category: 1 },
      { question: "What did Ana realize after her charity race?", adversarial_answer: "self-care is important", evidence: ["D1:2"], category: 5 },
      { question: "Where does Ana live now?", answer: "Lisbon", evidence: ["D"], category: 3 },
    ],
  };
}

const conversation = () => readConversation(sample(), 0);

function tmp(name: string, value: unknown) {
  const dir = mkdtempSync(join(tmpdir(), "locomo-test-"));
  const path = join(dir, name);
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
  return path;
}

const AUDIT = [
  { question_id: "locomo_0_qa0", question: "What is the name of Ana's puppy?", golden_answer: "Biscuit", category: 4, error_type: "WRONG_CITATION", correct_answer: "Biscuit (answer is correct, citation is wrong)" },
  { question_id: "locomo_0_qa1", question: "When did Ben run a charity race?", golden_answer: "The Saturday before 8 May 2023", category: 2, error_type: "TEMPORAL_ERROR", correct_answer: "6 May 2023" },
];
const auditKey = () => loadAuditKey(tmp("errors.json", AUDIT), [conversation()]);

type Reply = { text: string; modelIds: string[]; usage: Record<string, number> | null; notionalCostUsd: number | null };
const model = (answer: (prompt: string) => string, prompts: string[] = []) => ({
  kind: "fake",
  describe: () => ({ kind: "fake" }),
  complete: async (prompt: string): Promise<Reply> => {
    prompts.push(prompt);
    return { text: answer(prompt), modelIds: ["fake-model"], usage: { input_tokens: 10, cache_read_input_tokens: 5, output_tokens: 2 }, notionalCostUsd: 0.01 };
  },
});
/** The reader always says "6 May 2023"; this judge accepts it only against that gold answer, so the corrected key flips the race question and nothing else. */
const judge = (prompts: string[] = []) => model((p) => (p.includes("Gold answer: 6 May 2023\n") ? 'Same date.\n{"label": "CORRECT"}' : '{"label": "WRONG"}'), prompts);
const reader = (prompts: string[] = []) => model((p) => (p.includes("realize") ? "Not mentioned in the conversation." : "6 May 2023"), prompts);
const store = () => new lib.InMemoryStore();

describe("LoCoMo data — dates, sessions, question ids and evidence", () => {
  it("reads the dataset's session dates as UTC, with 12 am and 12 pm right, and refuses impossible ones", () => {
    expect(parseLocomoDate("1:56 pm on 8 May, 2023")).toBe("2023-05-08T13:56:00.000Z");
    expect(parseLocomoDate("12:09 am on 13 September, 2023")).toBe("2023-09-13T00:09:00.000Z");
    expect(parseLocomoDate("12:30 pm on 1 January, 2024")).toBe("2024-01-01T12:30:00.000Z");
    expect(() => parseLocomoDate("1:00 pm on 31 February, 2023")).toThrow(/Invalid/);
    expect(() => parseLocomoDate("2023-05-08")).toThrow(/Unrecognised/);
  });

  it("orders sessions by number, skips a dated session with no turns, and dates 'now' at the last session", () => {
    const c = conversation();
    expect(c.sessions.map((s) => s.session)).toEqual([1, 2, 10]);
    expect(c.now).toBe("2023-08-01T20:00:00.000Z");
    expect(c.sessions[0]!.turns[2]).toMatchObject({ diaId: "D1:3", caption: "a photo of a dog on a beach" });
  });

  it("names questions as the audit does (sample and qa index, from 0), keeps adversarial traps apart, and stringifies numeric answers", () => {
    const qs = conversation().questions;
    expect(qs.map((q) => q.question_id)).toEqual(["locomo_0_qa0", "locomo_0_qa1", "locomo_0_qa2", "locomo_0_qa3", "locomo_0_qa4"]);
    expect(qs[2]).toMatchObject({ answer: "2023", adversarial: false });
    expect(qs[3]).toMatchObject({ answer: null, adversarial: true, adversarialAnswer: "self-care is important" });
  });

  it("reads malformed evidence strings and records what names no turn instead of dropping it", () => {
    const qs = conversation().questions;
    expect(qs[2]).toMatchObject({ evidence: ["D10:1"], evidenceUnresolved: ["D10:01; D2:9 (D2:9)"] });
    expect(qs[4]).toMatchObject({ evidence: [], evidenceUnresolved: ["D"] });
    expect(resolveEvidence(["D:11:26", "D8:6; D9:17"], new Set(["D11:26", "D8:6", "D9:17"]))).toEqual({ ids: ["D11:26", "D8:6", "D9:17"], unresolved: [] });
  });

  it("refuses a sample with a duplicate dia_id or an unanswered scored question", () => {
    const dup = sample();
    dup.conversation.session_2[1]!.dia_id = "D2:1";
    expect(() => readConversation(dup, 0)).toThrow(/D2:1 appears twice/);
    const noAnswer = sample();
    delete (noAnswer.qa[0] as { answer?: string }).answer;
    expect(() => readConversation(noAnswer, 0)).toThrow(/qa 0 \(category 4\) has no answer/);
  });

  it("selects the first N conversations and the categories asked for, and refuses an unknown category", () => {
    const all = loadConversations(tmp("locomo10.json", [sample(), { ...sample(), sample_id: "conv-y" }]));
    expect(all[1]!.questions[0]!.question_id).toBe("locomo_1_qa0");
    const picked = selectQuestions(all, { conversations: 1, categories: [5] });
    expect(picked.map((c) => c.sampleId)).toEqual(["conv-x"]);
    expect(picked[0]!.questions.map((q) => q.question_id)).toEqual(["locomo_0_qa3"]);
    expect(() => selectQuestions(all, { categories: [6] })).toThrow(/Unknown category 6/);
  });
});

describe("LoCoMo audit key — the corrected answers, checked against the data", () => {
  it("keeps every answer-changing entry and leaves citation-only ones out", () => {
    expect([...auditKey().entries()]).toEqual([["locomo_0_qa1", { correctAnswer: "6 May 2023", errorType: "TEMPORAL_ERROR" }]]);
  });

  it("refuses an entry that does not match the data, rather than correcting the wrong question", () => {
    const shifted = [{ ...AUDIT[1], question_id: "locomo_0_qa2" }];
    expect(() => loadAuditKey(tmp("e.json", shifted), [conversation()])).toThrow(/is for "When did Ben run a charity race\?"/);
    expect(() => loadAuditKey(tmp("e.json", [{ ...AUDIT[1], question_id: "locomo_9_qa1" }]), [conversation()])).toThrow(/not a question in the data/);
    expect(() => loadAuditKey(tmp("e.json", [{ ...AUDIT[1], golden_answer: "May" }]), [conversation()])).toThrow(/golden answer "May"/);
    expect(() => loadAuditKey(tmp("e.json", [{ ...AUDIT[1], correct_answer: " " }]), [conversation()])).toThrow(/no correct_answer/);
  });
});

describe("LoCoMo prompts — verbatim, and how verdicts are read", () => {
  const sha = (s: string) => createHash("sha256").update(s).digest("hex");

  it("the reader and judge prompts are byte for byte the pinned file's (prompts.yaml SHA-256 ba4f668e…)", () => {
    expect(sha(READING_TEMPLATES.c25)).toBe("f789deda0d05c115c149591e6cb1877d3173aaf9b0683bb5be3b30f863bcf64e");
    expect(sha(READING_TEMPLATES.memos)).toBe("51b9cff053872fe5562f0c6947497e79cc4c1c3cf9ca76e53b641cc922e18bc9");
    expect(sha(judgePrompt("{question}", "{golden_answer}", "{generated_answer}"))).toBe("bdb039992e4d9edbb4a0145a2df71260b79f84976a71bab468ee4fd7c8ef69ed");
    expect(sha(JUDGE_SYSTEM)).toBe("c3d0382717275e37b02420b3b20f9dcddc420a989b9b730b5f96178f8afd78ce");
  });

  it("the context lists shown turns in conversation order, each under its session date, with photo captions", () => {
    const c = conversation();
    const turns = [c.sessions[2]!.turns[0]!, c.sessions[0]!.turns[2]!, c.sessions[0]!.turns[0]!].map((t, i) => ({ ...t, session: [10, 1, 1][i]!, position: [0, 2, 0][i]!, dateText: ["8:00 pm on 1 August, 2023", "1:56 pm on 8 May, 2023", "1:56 pm on 8 May, 2023"][i]! }));
    expect(formatContext(c.speakers, turns).split("\n").slice(2)).toEqual([
      "[1:56 pm on 8 May, 2023] Ana: I adopted a puppy named Biscuit yesterday.",
      "[1:56 pm on 8 May, 2023] Ana: Look at this [shares a photo of a dog on a beach]",
      "[8:00 pm on 1 August, 2023] Ana: We moved to Lisbon last week.",
    ]);
    const prompt = answerPrompt(c, c.questions[0]!, turns);
    expect(prompt.startsWith("You are an intelligent memory assistant")).toBe(true);
    expect(prompt.endsWith("Question: What is the name of Ana's puppy?\n\nAnswer:\n")).toBe(true);
    expect(() => answerPrompt(c, c.questions[0]!, turns, "cot")).toThrow(/Unknown reading/);
  });

  it("reads the judge's JSON label, falls back to a lone CORRECT or WRONG, and throws on anything else", () => {
    expect(judgeLabel('It matches.\n{"label": "CORRECT"}')).toBe(true);
    expect(judgeLabel('```json\n{"label": "WRONG"}\n```')).toBe(false);
    expect(judgeLabel('The answer is not CORRECT here.\n{"label": "WRONG"}')).toBe(false);
    expect(judgeLabel("Same date. CORRECT")).toBe(true);
    expect(() => judgeLabel("CORRECT or WRONG, hard to say")).toThrow(/no single CORRECT or WRONG/);
    expect(() => judgeLabel("")).toThrow();
  });

  it("an adversarial question is judged on abstaining (LongMemEval's prompt), and by LoCoMo's keyword rule", () => {
    const q = conversation().questions[3]!;
    const p = adversarialJudgePrompt(q, "Self-care matters.");
    expect(p).toContain("I will give you an unanswerable question");
    expect(p).toContain('"self-care is important" is the plausible answer');
    expect(keywordRule("That is not mentioned in the conversation.")).toBe(true);
    expect(keywordRule("No information available.")).toBe(true);
    expect(keywordRule("I don't know")).toBe(false);
  });
});

describe("LoCoMo harness — memory, recall, verdicts and a run", () => {
  it("one memory per turn, as said, dated by its session; recall returns turns best first", async () => {
    const c = conversation();
    const { memories, recalled } = await recallConversation(lib, c, c.questions, { store });
    expect(memories).toBe(6);
    expect(recalled[0]!.turns[0]!.diaId).toBe("D1:1");
    expect(recalled[0]!.recall.ms).toBeGreaterThanOrEqual(0);
  });

  it("builds on the default SQLite store too", async () => {
    const c = conversation();
    const { recalled } = await recallConversation(lib, c, c.questions.slice(0, 1));
    expect(recalled[0]!.turns.map((t: { diaId: string }) => t.diaId)).toContain("D1:1");
  });

  it("a scored question the audit corrects is judged twice; one it does not keeps its verdict; top-k bounds what is shown", async () => {
    const c = conversation();
    const { recalled } = await recallConversation(lib, c, c.questions, { store });
    const judged: string[] = [];
    const readerPrompts: string[] = [];
    const opts = { memories: 6, topK: 1, answerer: reader(readerPrompts), judge: judge(judged), abstentionJudge: model(() => "yes"), auditKey: auditKey() };
    const race = await evaluateQuestion(c, recalled[1], opts);
    expect(race).toMatchObject({ correctedAnswer: "6 May 2023", auditErrorType: "TEMPORAL_ERROR", label: false, labelCorrected: true, readerInputTokens: 15 });
    expect(race.shownTurns).toHaveLength(1);
    expect(race.retrieval.at["any@5"]).toBe(1);
    expect(judged).toHaveLength(2);
    expect(judged[0]).toContain("Gold answer: The Saturday before 8 May 2023\nGenerated answer: 6 May 2023");
    const puppy = await evaluateQuestion(c, recalled[0], opts);
    expect(puppy).toMatchObject({ correctedAnswer: null, label: false, labelCorrected: false });
    expect(judged).toHaveLength(3);
    expect(readerPrompts[0]).toContain("Question: When did Ben run a charity race?");
  });

  it("an adversarial question goes to the abstention judge and the keyword rule, never the LoCoMo judge", async () => {
    const c = conversation();
    const { recalled } = await recallConversation(lib, c, c.questions, { store });
    const judged: string[] = [];
    const abstained: string[] = [];
    const row = await evaluateQuestion(c, recalled[3], { memories: 6, answerer: reader(), judge: judge(judged), abstentionJudge: model(() => "Yes.", abstained), auditKey: auditKey() });
    expect(row).toMatchObject({ adversarial: true, label: true, keywordRule: true });
    expect(row).not.toHaveProperty("labelCorrected");
    expect(judged).toHaveLength(0);
    expect(abstained[0]).toContain("unanswerable");
  });

  it("a question with no evidence turn is skipped in retrieval, with the reason", async () => {
    const c = conversation();
    const { recalled } = await recallConversation(lib, c, c.questions, { store });
    expect((await evaluateQuestion(c, recalled[4], { memories: 6 })).retrieval).toEqual({ skipped: "no-evidence" });
  });

  it("a run skips questions already done, records each row, and summarizes by category with adversarial apart", async () => {
    const c = conversation();
    const seen: string[] = [];
    const rows = await runLocomo(lib, [c], { store, answerer: reader(), judge: judge(), abstentionJudge: model(() => "yes"), auditKey: auditKey() }, { concurrency: 2, done: new Set(["locomo_0_qa4"]), onRow: (r: { question_id: string }) => void seen.push(r.question_id) });
    expect(seen.sort()).toEqual(["locomo_0_qa0", "locomo_0_qa1", "locomo_0_qa2", "locomo_0_qa3"]);
    const s = summarize(rows);
    expect(s).toMatchObject({ questions: 4, errors: 0, answered: 4 });
    expect(s.scored.published).toEqual({ n: 3, correct: 0, accuracy: 0 });
    expect(s.scored.corrected).toEqual({ n: 3, correct: 1, accuracy: 0.3333 });
    expect(s.scored.keyChanged).toEqual({ questions: 1, wrongToCorrect: 1, correctToWrong: 0 });
    expect(s.scored.byCategory[2]).toMatchObject({ size: 321, published: { n: 1, correct: 0 }, corrected: { n: 1, correct: 1 } });
    expect(s.adversarial).toMatchObject({ size: 446, questions: 1, abstentionJudge: { n: 1, correct: 1 }, keywordRule: { n: 1, correct: 1 } });
    expect(s.calls).toEqual({ answer: 4, judge: 4, judgeCorrected: 1 });
    expect(s.reader.inputTokensPerQuestion).toMatchObject({ mean: 15 });

    // The summary file's scoreboard: the published and corrected key side by side, category 5 on its own row, outside the four.
    const table = scoreTable(s);
    expect(table.map((r: { category: number | string }) => r.category)).toEqual([...[4, 1, 2, 3].filter((c) => s.scored.byCategory[c]), "1-4", 5]);
    expect(table.find((r: { category: number | string }) => r.category === 2)).toEqual({ category: 2, size: 321, judged: 1, published: 0, corrected: 1, correctPublished: 0, correctCorrected: 1 });
    expect(table.find((r: { category: number | string }) => r.category === "1-4")).toEqual({ category: "1-4", size: 1540, judged: 3, published: 0, corrected: 0.3333, correctPublished: 0, correctCorrected: 1 });
    expect(table.at(-1)).toEqual({ category: 5, size: 446, inOverall: false, judged: 1, abstentionJudge: 1, keywordRule: 1, keywordRuleN: 1 });
  });

  it("a retrieval-only run's scoreboard has the rows and no accuracy, never a zero", () => {
    const table = scoreTable(summarize([{ question_id: "q", category: 4, adversarial: false, correctedAnswer: null, retrieval: { skipped: "no-evidence" }, shownTurns: [] }]));
    expect(table[0]).toMatchObject({ category: 4, judged: 0, published: null, corrected: null });
    expect(table.at(-1)).toMatchObject({ category: 5, judged: 0, abstentionJudge: null, keywordRule: null });
  });

  it("an unreadable verdict is that question's error, in its own words; three in a row stop the run with counts", async () => {
    const c = conversation();
    const mute = model(() => "no idea");
    await expect(runLocomo(lib, [c], { store, answerer: reader(), judge: mute, abstentionJudge: mute }, { concurrency: 1 })).rejects.toMatchObject({
      attempted: 3,
      succeeded: 0,
      rows: [0, 1, 2].map((i) => ({ question_id: `locomo_0_qa${i}`, error: 'The judge gave no single CORRECT or WRONG label: "no idea"' })),
    });
  });

  it("a usage limit stops the run and is rethrown, with the rows that finished", async () => {
    let calls = 0;
    const limited = { ...reader(), complete: async (p: string) => (++calls === 2 ? Promise.reject(new UsageLimitError("usage limit reached")) : reader().complete(p)) };
    const run = runLocomo(lib, [conversation()], { store, answerer: limited }, { concurrency: 1 });
    await expect(run).rejects.toBeInstanceOf(UsageLimitError);
    await run.catch((e: { rows: unknown[]; attempted: number }) => expect([e.rows.length, e.attempted]).toEqual([1, 1]));
  });

  it("a memory that cannot be built errors its questions with the reason, and stops after three", async () => {
    const broken = () => ({ ...new lib.InMemoryStore(), addNode: async () => { throw new Error("disk full"); }, close() {} });
    await expect(runLocomo(lib, [conversation()], { store: broken }, {})).rejects.toMatchObject({
      attempted: 3,
      succeeded: 0,
      rows: [0, 1, 2].map((i) => ({ question_id: `locomo_0_qa${i}`, error: "building the memory of conv-x failed: disk full" })),
    });
  });
});

describe("LoCoMo download — pinned commits, pinned bytes", () => {
  const body = "[]";
  const file = { repo: "o/r", commit: "a".repeat(40), path: "data/x.json", sha256: createHash("sha256").update(body).digest("hex"), bytes: body.length };
  const ok = () => new Response(body);

  it("asks for the pinned commit, never a branch, and falls back from the API to raw", async () => {
    expect(fileUrls(file).map((u) => u.url)).toEqual([`https://api.github.com/repos/o/r/contents/data/x.json?ref=${"a".repeat(40)}`, `https://raw.githubusercontent.com/o/r/${"a".repeat(40)}/data/x.json`]);
    const dataDir = mkdtempSync(join(tmpdir(), "locomo-dl-"));
    const asked: string[] = [];
    const lines = await ensureFiles({ files: { data: file } }, { dataDir, fetchImpl: async (u: string) => (asked.push(u), asked.length === 1 ? new Response("nope", { status: 500 }) : ok()) });
    expect(asked).toHaveLength(2);
    expect(lines[0]).toMatch(/verified/);
    expect(readFileSync(localPath(file, dataDir), "utf8")).toBe(body);
    // Present now: verified, not fetched again.
    expect(await ensureFiles({ files: { data: file } }, { dataDir, fetchImpl: async () => { throw new Error("no network"); } })).toEqual([`data: ${localPath(file, dataDir)} present and verified`]);
  });

  it("keeps nothing whose SHA-256 is not the pinned one, and names every URL that failed", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "locomo-dl-"));
    await expect(ensureFiles({ files: { data: file } }, { dataDir, fetchImpl: async () => new Response("[1]") })).rejects.toThrow(/api\.github\.com.*SHA-256[\s\S]*raw\.githubusercontent\.com.*SHA-256/);
    expect(existsSync(localPath(file, dataDir))).toBe(false);
  });
});
