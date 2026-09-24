/**
 * Mental models, as every MemoryStore must support them: a standing question
 * whose answer is written by a refresh, read with no model call, marked stale
 * when what it rests on changes, and never allowed to outlive an erased fact.
 *
 * Exported and run by each store's own test file, like the main conformance suite.
 */
import { describe, expect, it } from "vitest";

import { makeNode } from "./memory-store-conformance.spec.js";
import { consolidate } from "./consolidation.js";
import { defineMentalModel, deleteMentalModel, getMentalModel, listMentalModels, mentalModelAsOf, mentalModelHistory, refreshMentalModels, type ModelProposal, type ModelRequest } from "./mental-models.js";
import type { MemoryStore } from "./types/memory.js";

// After the real clock: facts are recorded at real time, and a model reads what is true "now".
const T0 = new Date("2099-01-01T10:00:00.000Z");
const at = (minutes: number): Date => new Date(T0.getTime() + minutes * 60_000);

/** A judgement that answers every question by quoting the first sentence of each fact it is shown. */
function quoting(answer = (r: ModelRequest) => `About ${r.question}: ${r.facts.map((f) => f.text).join(" / ")}`) {
  const seen: ModelRequest[][] = [];
  const propose = async (requests: readonly ModelRequest[]): Promise<ModelProposal[]> => {
    seen.push([...requests]);
    return requests.map((r) => ({ modelId: r.modelId, answer: answer(r), evidence: r.facts.map((f) => ({ nodeId: f.nodeId, quote: f.text })) }));
  };
  return { propose, seen };
}

export function runMentalModelConformance(label: string, makeStore: () => MemoryStore): void {
  describe(`${label} — mental models`, () => {
    it("a defined model has no answer and says so; a refresh answers it; reading costs no model call", async () => {
      const store = makeStore();
      await store.addNode(makeNode({ content: { text: "Chris picks tools with a strong adoption signal." }, contextualMetadata: { tags: ["tools"] } }));
      const id = await defineMentalModel(store, { question: "What does Chris care about when choosing tools?", scope: { tags: ["tools"] } });
      const before = await getMentalModel(store, id, { now: () => at(1) });
      expect(before).toMatchObject({ answer: null, fresh: false, stale: { because: "not answered yet" } });

      const judge = quoting();
      const report = await refreshMentalModels(store, { propose: judge.propose, now: () => at(2) });
      expect(report).toMatchObject({ asked: 1, refused: [] });
      expect(judge.seen[0]![0]!.facts.map((f) => f.text)).toEqual(["Chris picks tools with a strong adoption signal."]);

      const after = await getMentalModel(store, id, { now: () => at(3) });
      expect(after).toMatchObject({ fresh: true, stale: null, withheld: false });
      expect(after!.answer).toContain("strong adoption signal");
      expect(after!.evidence).toEqual([expect.objectContaining({ source: "available", holds: true })]);
      // Fresh models are not asked about again.
      expect((await refreshMentalModels(store, { propose: judge.propose, now: () => at(4) })).asked).toBe(0);
    });

    it("refuses an answer whose quotes are not in its facts, and keeps the previous answer", async () => {
      const store = makeStore();
      const f = await store.addNode(makeNode({ content: { text: "The launch is on Thursday." }, contextualMetadata: { tags: ["launch"] } }));
      const id = await defineMentalModel(store, { question: "When is the launch?", scope: { tags: ["launch"] } });
      await refreshMentalModels(store, { propose: quoting().propose, now: () => at(1) });
      const first = await getMentalModel(store, id, { now: () => at(2) });
      await store.addNode(makeNode({ content: { text: "The launch moved to November." }, contextualMetadata: { tags: ["launch"] } }));

      const invented = async (rs: readonly ModelRequest[]): Promise<ModelProposal[]> => rs.map((r) => ({ modelId: r.modelId, answer: "It is tomorrow.", evidence: [{ nodeId: f.nodeId, quote: "The launch is tomorrow." }] }));
      const report = await refreshMentalModels(store, { propose: invented, now: () => at(3) });
      expect(report.refused).toEqual([{ modelId: id, why: expect.stringMatching(/^unsupported: quote not found/) }]);
      const noQuotes = async (rs: readonly ModelRequest[]): Promise<ModelProposal[]> => rs.map((r) => ({ modelId: r.modelId, answer: "Soon.", evidence: [] }));
      expect((await refreshMentalModels(store, { propose: noQuotes, now: () => at(4) })).refused[0]!.why).toMatch(/no evidence/);

      const still = await getMentalModel(store, id, { now: () => at(5) });
      expect(still!.answerId).toBe(first!.answerId);
      expect(still!.stale!.because).toMatch(/newer fact/);
    });

    it("new facts in scope make it stale; a refresh keeps every earlier answer, readable as of a date", async () => {
      const store = makeStore();
      await store.addNode(makeNode({ content: { text: "Stage: prototypes ordered." }, contextualMetadata: { tags: ["ptk"] } }));
      const id = await defineMentalModel(store, { question: "Where is the game?", scope: { tags: ["ptk"] } });
      await refreshMentalModels(store, { propose: quoting((r) => r.facts[0]!.text).propose, now: () => at(1) });
      await store.addNode(makeNode({ content: { text: "Stage: prototypes arrived." }, contextualMetadata: { tags: ["ptk"] } }));
      await store.addNode(makeNode({ content: { text: "Unrelated fact." }, contextualMetadata: { tags: ["other"] } }));

      const stale = await getMentalModel(store, id, { now: () => at(30) });
      expect(stale).toMatchObject({ fresh: false, stale: { because: "1 newer fact in scope since the last answer" } });
      await refreshMentalModels(store, { propose: quoting((r) => r.facts.map((f) => f.text).sort().join(" ")).propose, now: () => at(60) });

      const history = await mentalModelHistory(store, id);
      expect(history.map((h) => h.answer)).toEqual(["Stage: prototypes ordered.", "Stage: prototypes arrived. Stage: prototypes ordered."]);
      expect(history[0]!.ended).toEqual({ by: "refresh", supersededBy: history[1]!.answerId });
      expect((await mentalModelAsOf(store, id, at(30).toISOString()))!.answer).toBe("Stage: prototypes ordered.");
      expect((await mentalModelAsOf(store, id, at(90).toISOString()))!.answer).toContain("prototypes arrived");
    });

    it("a fact that STOPS BEING TRUE retracts the answer resting on it: kept in history, the model reads stale", async () => {
      const store = makeStore();
      const f = await store.addNode(makeNode({ content: { text: "Chris lives in London." }, contextualMetadata: { tags: ["home"] } }));
      const id = await defineMentalModel(store, { question: "Where does Chris live?", scope: { tags: ["home"] } });
      await refreshMentalModels(store, { propose: quoting((r) => r.facts[0]!.text).propose, now: () => at(1) });
      await store.updateNode(f.nodeId, { validTo: at(10).toISOString() });

      const m = await getMentalModel(store, id, { now: () => at(20) });
      expect(m).toMatchObject({ fresh: false, answer: "Chris lives in London." });
      expect(m!.stale!.because).toMatch(/a source stopped being true/);
      expect((await mentalModelHistory(store, id))[0]!.ended).toMatchObject({ by: "invalidation" });
      // The definition itself is untouched: the model is still there to refresh.
      expect((await listMentalModels(store, { now: () => at(20) })).map((x) => x.id)).toEqual([id]);
    });

    it("a fact that MUST NOT EXIST erases the answer built from it — its words cannot survive in a summary", async () => {
      const store = makeStore();
      const secret = await store.addNode(makeNode({ content: { text: "The pin code is 4321." }, contextualMetadata: { tags: ["home"] } }));
      const id = await defineMentalModel(store, { question: "What should Al know about home?", scope: { tags: ["home"] } });
      const report = await refreshMentalModels(store, { propose: quoting().propose, now: () => at(1) });
      const answerId = report.written[0]!.answerId;
      await store.deleteNode(secret.nodeId);

      expect(await store.getNode(answerId)).toBeFalsy();
      const m = await getMentalModel(store, id, { now: () => at(5) });
      expect(m).toMatchObject({ answer: null, fresh: false, withheld: true });
      expect(m!.stale!.because).toMatch(/erased along with a fact it rested on/);
      expect(JSON.stringify(await store.listNodes())).not.toContain("4321");
    });

    it("an answer is as restricted as its most restricted fact; Sealed facts are never shown; Sensitive only when the host opts in", async () => {
      const store = makeStore();
      await store.addNode(makeNode({ content: { text: "Sealed thing." }, privacyClassification: "Sealed", contextualMetadata: { tags: ["x"] } }));
      await store.addNode(makeNode({ content: { text: "Sensitive thing." }, privacyClassification: "Sensitive", contextualMetadata: { tags: ["x"] } }));
      await store.addNode(makeNode({ content: { text: "Private thing." }, contextualMetadata: { tags: ["x"] } }));
      const id = await defineMentalModel(store, { question: "What is there?", scope: { tags: ["x"] } });

      const plain = quoting();
      await refreshMentalModels(store, { propose: plain.propose, now: () => at(1) });
      expect(plain.seen[0]![0]!.facts.map((f) => f.text)).toEqual(["Private thing."]);
      expect((await getMentalModel(store, id, { now: () => at(2) }))!.privacyClassification).toBe("Private");

      const opted = quoting();
      await refreshMentalModels(store, { propose: opted.propose, now: () => at(3), onlyStale: false, includeSensitive: true });
      expect(opted.seen[0]![0]!.facts.map((f) => f.text).sort()).toEqual(["Private thing.", "Sensitive thing."]);
      expect((await getMentalModel(store, id, { now: () => at(4) }))!.privacyClassification).toBe("Sensitive");
    });

    it("model nodes are never facts: not fed to a model, not consolidated", async () => {
      const store = makeStore();
      await store.addNode(makeNode({ content: { text: "A real fact." }, contextualMetadata: { tags: ["a"] } }));
      await defineMentalModel(store, { question: "What is true?", scope: {} });
      const judge = quoting();
      await refreshMentalModels(store, { propose: judge.propose, now: () => at(1) });
      expect(judge.seen[0]![0]!.facts.map((f) => f.text)).toEqual(["A real fact."]);

      const shown: string[] = [];
      await consolidate(store, { since: "2000-01-01T00:00:00Z", model: "m", propose: async (raw) => { shown.push(...raw.map((r) => r.text)); return []; } });
      expect(shown).toEqual(["A real fact."]);
    });

    it("deleteMentalModel erases its answers and its definition", async () => {
      const store = makeStore();
      await store.addNode(makeNode({ content: { text: "Fact." }, contextualMetadata: { tags: ["a"] } }));
      const id = await defineMentalModel(store, { question: "Q?", scope: { tags: ["a"] } });
      await refreshMentalModels(store, { propose: quoting().propose, now: () => at(1) });
      expect(await deleteMentalModel(store, id)).toEqual({ erased: 2 });
      expect(await listMentalModels(store)).toEqual([]);
      expect((await store.listNodes()).map((n) => n.content.text)).toEqual(["Fact."]);
    });

    it("refuses an empty or over-long question", async () => {
      const store = makeStore();
      await expect(defineMentalModel(store, { question: "   " })).rejects.toThrow(/needs a question/);
      await expect(defineMentalModel(store, { question: "x".repeat(501) })).rejects.toThrow(/at most 500/);
    });
  });
}
