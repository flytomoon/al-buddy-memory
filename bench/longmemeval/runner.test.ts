import { describe, expect, it } from "vitest";

import * as lib from "../../src/index.js";
import { UsageLimitError } from "./answerers.mjs";
import { evaluateInstance, runInstances, summarize } from "./harness.mjs";
import { cachingEmbedder, ingestHistory, recallRounds } from "./memory.mjs";
import { instance } from "./fixture.js";

/** A word-presence embedder: deterministic, and enough to give the vector side something to rank. */
const WORDS = ["city", "move", "moved", "tokyo", "berlin", "work", "baking", "sourdough", "japanese"];
function wordEmbedder() {
  return new lib.FakeEmbedder("words", WORDS.length, (text) => WORDS.map((w) => (text.toLowerCase().includes(w) ? 1 : 0)));
}

describe("LongMemEval ingestion — the public API, one memory per message", () => {
  it("files each message with its provenance, type, session date and session tag", async () => {
    const memory = await ingestHistory(lib, instance());
    try {
      const nodes = await memory.store.listNodes();
      expect(nodes).toHaveLength(9);
      const tokyo = nodes.find((n) => n.content.text === "I just moved to Tokyo for work.")!;
      expect(tokyo.provenance).toBe("UserInput");
      expect(tokyo.memoryType).toBe("Conversation");
      expect(tokyo.validFrom).toBe("2023-02-10T18:30:00.000Z");
      expect(tokyo.contextualMetadata).toMatchObject({ tags: ["answer_x1_1"], session: "answer_x1_1", turn: 0, role: "user" });
      expect(nodes.find((n) => n.content.text.startsWith("Congratulations"))!.provenance).toBe("AIInferred");
      // has_answer is the benchmark's label; it never reaches the memory.
      expect(JSON.stringify(nodes)).not.toContain("has_answer");
    } finally {
      memory.store.close();
    }
  });

  it("skips empty messages rather than storing blank memories", async () => {
    const x = instance();
    (x.haystack_sessions[0] as { content: string }[])[2]!.content = "   ";
    const memory = await ingestHistory(lib, x);
    expect(memory.memories).toBe(8);
    memory.store.close();
  });
});

describe("LongMemEval recall — memories back to the rounds the official reader sees", () => {
  it("names a round by its user turn, and an assistant hit brings its whole round", async () => {
    const x = instance({ question: "cycling" });
    const memory = await ingestHistory(lib, x);
    try {
      const { rounds } = await recallRounds(memory, x);
      expect(rounds).toEqual([
        {
          id: "answer_x1_2_1",
          date: "2023/05/20 (Sat) 02:21",
          turns: [
            { role: "user", content: "Update: I relocated to Berlin last week." },
            { role: "assistant", content: "Berlin is a great city for cycling." },
          ],
        },
      ]);
    } finally {
      memory.store.close();
    }
  });

  it("an assistant turn that opens a session belongs to the first user turn after it", async () => {
    const x = instance({ question: "baking" });
    const memory = await ingestHistory(lib, x);
    try {
      const { rounds } = await recallRounds(memory, x);
      expect(rounds.map((r) => r.id)).toEqual(["filler_a1_2"]);
    } finally {
      memory.store.close();
    }
  });

  it("a user turn and its reply both matching is one round, not two, and every id is in the official corpus", async () => {
    const x = instance();
    const memory = await ingestHistory(lib, x);
    try {
      const { rounds, memoriesRecalled } = await recallRounds(memory, x);
      const ids = rounds.map((r) => r.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(memoriesRecalled).toBeGreaterThan(rounds.length);
      expect(ids).toContain("answer_x1_1_1");
      for (const id of ids) expect(["filler_a1_2", "answer_x1_1_1", "noans_x1_1_3", "answer_x1_2_1"]).toContain(id);
    } finally {
      memory.store.close();
    }
  });

  it("with an embedder, every memory is embedded before the question and recall fuses both lists", async () => {
    const x = instance({ question: "Which city?" });
    const memory = await ingestHistory(lib, x, { embedder: wordEmbedder() });
    try {
      expect(await memory.store.listEmbeddings("words")).toHaveLength(memory.memories);
      const { rounds } = await recallRounds(memory, x);
      expect(rounds.map((r) => r.id)).toContain("answer_x1_2_1");
    } finally {
      memory.store.close();
    }
  });

  it("the caching embedder embeds each distinct text once across stores, and returns the same vectors", async () => {
    const seen: string[] = [];
    const inner = new lib.FakeEmbedder("words", 2, (t) => {
      seen.push(t);
      return [t.length, 0.1];
    });
    const cached = cachingEmbedder(inner);
    for (let i = 0; i < 2; i += 1) {
      const memory = await ingestHistory(lib, instance(), { embedder: cached });
      memory.store.close();
    }
    expect(seen).toHaveLength(9);
    expect(cached.stats).toEqual({ embedded: 9, reused: 9 });
    // 0.1 is not a float32 value, so the cache keeps the exact double.
    expect(await cached.embed(["Try a daily flashcard habit."])).toEqual([[28, 0.1]]);
  });
});

const reader = (text: string, prompts: string[] = []) => ({
  kind: "fake",
  describe: () => ({ kind: "fake" }),
  complete: async (prompt: string) => {
    prompts.push(prompt);
    return { text, modelIds: ["fake-reader"], usage: { input_tokens: prompt.length, output_tokens: 3 }, notionalCostUsd: 0.01 };
  },
});

describe("LongMemEval harness — one question end to end, and a run", () => {
  it("retrieval metrics, the reader prompt, the answer and the official verdict in one row", async () => {
    const readerPrompts: string[] = [];
    const judgePrompts: string[] = [];
    const row = await evaluateInstance(lib, instance(), { topK: 2, answerer: reader("You moved to Berlin.", readerPrompts), judge: reader("yes", judgePrompts) });
    expect(row.retrieval.skipped).toBeNull();
    expect(row.retrieval.metrics.session["recall_any@50"]).toBe(1);
    expect(row.shownRounds.length).toBeLessThanOrEqual(2);
    expect(readerPrompts[0]).toContain("Current Date: 2023/06/01 (Thu) 10:00\nQuestion: What city did I move to for work?");
    expect(judgePrompts[0]).toContain("Correct Answer: Berlin\n\nModel Response: You moved to Berlin.");
    expect(judgePrompts[0]).toContain("the updated answer is the required answer");
    expect(row).toMatchObject({ hypothesis: "You moved to Berlin.", label: true, answerModels: ["fake-reader"], judgeModels: ["fake-reader"] });
  });

  it("an abstention question skips the retrieval average and is judged on abstaining", async () => {
    const judgePrompts: string[] = [];
    const row = await evaluateInstance(lib, instance({ question_id: "q-city_abs" }), { answerer: reader("I don't know."), judge: reader("No", judgePrompts) });
    expect(row.retrieval).toEqual({ skipped: "abstention" });
    expect(judgePrompts[0]).toContain("unanswerable");
    expect(row.label).toBe(false);
  });

  it("without an answerer the row has retrieval metrics only — no model is called", async () => {
    const row = await evaluateInstance(lib, instance());
    expect(row.retrieval.metrics).toBeDefined();
    expect(row).not.toHaveProperty("hypothesis");
  });

  it("a question that keeps failing becomes an error row and the run goes on", async () => {
    const flaky = {
      ...reader("x"),
      complete: async (prompt: string) => {
        if (prompt.includes("Question: broken")) throw new Error("reader crashed");
        return { text: "Berlin", modelIds: ["fake-reader"], usage: null, notionalCostUsd: null };
      },
    };
    const seen: string[] = [];
    const rows = await runInstances(lib, [instance({ question_id: "a" }), instance({ question_id: "b", question: "broken" }), instance({ question_id: "c" })], { answerer: flaky }, { concurrency: 2, onRow: (r: { question_id: string }) => void seen.push(r.question_id) });
    expect(seen.sort()).toEqual(["a", "b", "c"]);
    expect(rows.find((r: { question_id: string }) => r.question_id === "b")).toMatchObject({ error: "reader crashed" });
    const s = summarize(rows);
    expect(s).toMatchObject({ questions: 3, errors: 1, answered: 2, models: { answer: { "fake-reader": 2 }, judge: {} } });
  });

  it("a usage limit stops the run: nothing new starts, and the error carries the rows that finished", async () => {
    let calls = 0;
    const limited = {
      ...reader("x"),
      complete: async () => {
        calls += 1;
        if (calls === 2) throw new UsageLimitError("Claude subscription limit: usage limit reached");
        return { text: "Berlin", modelIds: ["fake-reader"], usage: null, notionalCostUsd: null };
      },
    };
    const run = runInstances(lib, ["a", "b", "c", "d"].map((id) => instance({ question_id: id })), { answerer: limited }, { concurrency: 1 });
    await expect(run).rejects.toBeInstanceOf(UsageLimitError);
    await run.catch((e: { rows: unknown[] }) => expect(e.rows).toHaveLength(1));
    expect(calls).toBe(2);
  });

  it("sums the CLI's usage and notional cost, and counts every model id that answered", () => {
    const s = summarize([
      { question_id: "a", question_type: "multi-session", retrieval: { skipped: "abstention" }, answerModels: ["m1"], judgeModels: ["j1"], answerUsage: { input_tokens: 10 }, judgeUsage: { input_tokens: 2 }, answerNotionalCostUsd: 0.5, judgeNotionalCostUsd: 0.25, label: true, hypothesis: "h", promptChars: 100, ms: 2000 },
      { question_id: "b", question_type: "multi-session", retrieval: { skipped: "abstention" }, answerModels: ["m1", "m2"], answerUsage: { input_tokens: 5, service_tier: "standard" }, answerNotionalCostUsd: 0.5, label: false, hypothesis: "h", promptChars: 300, ms: 4000 },
    ]);
    expect(s.models).toEqual({ answer: { m1: 2, m2: 1 }, judge: { j1: 1 } });
    expect(s.usage).toEqual({ answer: { input_tokens: 15 }, judge: { input_tokens: 2 } });
    expect(s.notionalCostUsd).toBe(1.25);
    expect(s.meanPromptChars).toBe(200);
    expect(s.meanSecondsPerQuestion).toBe(3);
    expect(s.qa.overallAccuracy).toBe(0.5);
  });
});
