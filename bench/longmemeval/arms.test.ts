import { describe, expect, it } from "vitest";
// The fixture test runs on an InMemoryStore, so this file needs no SQLite binding.

import * as lib from "../../src/index.js";
import { armRecallSettings, gainBarCheck, gainBarSentence, parseArm, shownChars, summarizeShownChars } from "./arms.mjs";
import { ingestHistory, recallRounds } from "./memory.mjs";
import { instance } from "./fixture.js";

const WORDS = ["city", "move", "moved", "tokyo", "berlin", "work", "baking", "sourdough", "japanese", "week"];
const wordEmbedder = () => new lib.FakeEmbedder("words", WORDS.length, (text) => WORDS.map((w) => (text.toLowerCase().includes(w) ? 1 : 0)));

describe("recall-sweep arms — the raw-retrieval baseline beside the shipped default", () => {
  it("none is plain recall: no expand, no options, no cross-encoder, no build", () => {
    expect(parseArm("none")).toEqual({ name: "none", expand: false, contentWords: false, build: null, rerank: null });
    expect(armRecallSettings(parseArm("none"))).toEqual({ expand: false, recallOptions: {} });
  });

  it("expand is the MCP recall tool's default, and joins other parts", () => {
    expect(parseArm("expand")).toMatchObject({ name: "expand", expand: true, rerank: null });
    expect(armRecallSettings(parseArm("expand"))).toEqual({ expand: true, recallOptions: {} });
    const both = parseArm("expand+content-words+minilm:q8:30:window");
    expect(both).toMatchObject({ name: "expand+content-words+minilm:q8:30:window", expand: true, contentWords: true });
    expect(both.rerank).toEqual({ short: "minilm", model: "Xenova/ms-marco-MiniLM-L-6-v2", dtype: "q8", depth: 30, depthSpec: "30", when: "window", part: "minilm:q8:30:window" });
    expect(armRecallSettings(both)).toEqual({ expand: true, recallOptions: { contentWords: true } });
  });

  it("the sweep's --expand still expands every arm, and an expand arm beside it is refused", () => {
    expect(armRecallSettings(parseArm("none", { globalExpand: true }), { globalExpand: true })).toEqual({ expand: true, recallOptions: {} });
    expect(() => parseArm("expand", { globalExpand: true })).toThrow("--arm expand: --expand already expands every arm");
  });

  it("refuses what it does not know, and recall options on a build arm", () => {
    expect(() => parseArm("expnad")).toThrow(/--arm expnad: unknown part "expnad" \(have: none, expand, content-words/);
    expect(() => parseArm("build:../base/dist+expand")).toThrow("a build arm recalls as that build does");
    expect(() => parseArm("expand+expand")).toThrow("expand twice");
    expect(() => parseArm("none+expand")).toThrow(`"none" is an arm on its own`);
    expect(() => parseArm("minilm:q8:0")).toThrow("depth must be an integer");
    expect(() => parseArm("build:")).toThrow("build: needs a directory");
    expect(parseArm("build:../base/dist")).toMatchObject({ name: "build:../base/dist", build: "../base/dist" });
  });

  it("the baseline and the default arm both run on an InMemoryStore fixture, with the same result shape", async () => {
    const x = instance({ question: "Where did I move last week?" });
    const embedder = wordEmbedder();
    const memory = await ingestHistory(lib, x, { embedder, store: () => new lib.InMemoryStore() });
    expect(memory.store).toBeInstanceOf(lib.InMemoryStore);
    const results: Record<string, Awaited<ReturnType<typeof recallRounds>>> = {};
    for (const spec of ["none", "expand"]) {
      const arm = parseArm(spec);
      const { expand, recallOptions } = armRecallSettings(arm);
      results[arm.name] = await recallRounds({ ...memory, retriever: new lib.HybridRetriever(memory.store, embedder) }, x, { expand, recallOptions });
    }
    // The raw arm is exactly recall with no options at all.
    const plain = await recallRounds(memory, x);
    expect(results.none!.rounds).toEqual(plain.rounds);
    for (const r of Object.values(results)) {
      expect(Object.keys(r).sort()).toEqual(["memoriesRecalled", "recall", "rounds"]);
      expect(Object.keys(r.recall).sort()).toEqual(["cpuMs", "ms"]);
      expect(r.rounds.length).toBeGreaterThan(0);
      for (const round of r.rounds) expect(Object.keys(round).sort()).toEqual(["date", "id", "turns"]);
      expect(shownChars(r.rounds)).toBeGreaterThan(0);
    }
  });

  it("counts what the reader would be handed, in characters and estimated tokens", () => {
    const rounds = [{ turns: [{ content: "abcd" }, { content: "efgh" }] }, { turns: [{ content: "ijklmnop" }] }];
    expect(shownChars(rounds)).toBe(16);
    expect(shownChars([])).toBe(0);
    expect(summarizeShownChars([40, 400, 4000, undefined])).toEqual({
      n: 3,
      chars: { p50: 400, p95: 4000, mean: 1480 },
      approxTokens: { p50: 100, p95: 1000, mean: 370 },
    });
    expect(summarizeShownChars([])).toBeNull();
  });
});

describe("recall-sweep --gain-bar — net questions newly shown every evidence turn", () => {
  const arm = (gained: string[], lost: string[], p50: number) => ({ allEvidenceVs: { arm: "none", gained, lost }, recall: { ms: { p50 } } });
  const summary = { none: arm([], [], 30), "minilm:fp32:all": arm(["a", "b", "c", "d", "e"], ["f"], 900), "bge:fp32:all": arm(["a", "b", "c", "d", "e", "g"], ["f"], 4000) };

  it("holds every arm after the first to the bar, net of what it stops showing", () => {
    const bar = gainBarCheck(summary, ["none", "minilm:fp32:all", "bge:fp32:all"], 5);
    expect(bar.against).toBe("none");
    expect(bar.arms["minilm:fp32:all"]).toEqual({ gained: 5, lost: 1, net: 4, pass: false, recallMsP50: 900 });
    expect(bar.arms["bge:fp32:all"]).toEqual({ gained: 6, lost: 1, net: 5, pass: true, recallMsP50: 4000 });
    expect(gainBarSentence(bar, { questions: 50, againstMsP50: 30 })).toBe(
      "over 50 questions against none (recall p50 30 ms), minilm:fp32:all newly showed every evidence turn in 5 and stopped in 1 (net +4; bar +5: FAIL), recall p50 900 ms; " +
        "bge:fp32:all newly showed every evidence turn in 6 and stopped in 1 (net +5; bar +5: PASS), recall p50 4000 ms",
    );
  });

  it("refuses a bar with nothing to hold to it, or a bar below one", () => {
    expect(() => gainBarCheck(summary, ["none"], 5)).toThrow(/second arm/);
    expect(() => gainBarCheck(summary, ["none", "bge:fp32:all"], 0)).toThrow(/>= 1/);
  });
});
