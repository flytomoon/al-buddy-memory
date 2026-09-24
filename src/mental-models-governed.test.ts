import { describe, expect, it } from "vitest";

import { govern } from "./governance/governed-store.js";
import { personalDefaults } from "./governance/samples.js";
import { InMemoryStore } from "./in-memory-store.js";
import { makeNode } from "./memory-store-conformance.spec.js";
import { exportPortable, importPortable } from "./memory-portability.js";
import { governanceTools, serverStore } from "./mcp/governance-server.js";
import { defineMentalModel, getMentalModel, mentalModelHistory, refreshMentalModels, type ModelProposal, type ModelRequest } from "./mental-models.js";

const later = () => new Date("2099-01-01T10:00:00.000Z");
const quoting = async (rs: readonly ModelRequest[]): Promise<ModelProposal[]> =>
  rs.map((r) => ({ modelId: r.modelId, answer: r.facts.map((f) => f.text).join(" "), evidence: r.facts.map((f) => ({ nodeId: f.nodeId, quote: f.text })) }));

describe("mental models through a governed handle", () => {
  it("an answer built from a Sensitive fact is withheld from an assistant; the owner in person reads it", async () => {
    const inner = new InMemoryStore();
    const owner = govern(inner, { policies: [personalDefaults({ owner: "owner" })], context: () => ({ actor: "owner" }) });
    await owner.addNode(makeNode({ content: { text: "Sees a therapist on Thursdays." }, privacyClassification: "Sensitive", contextualMetadata: { tags: ["health"] } }));
    const id = await defineMentalModel(owner, { question: "What matters about Chris's week?", scope: { tags: ["health"] } });
    await refreshMentalModels(owner, { propose: quoting, now: later, includeSensitive: true });

    const mine = await getMentalModel(owner, id, { now: later });
    expect(mine).toMatchObject({ answer: "Sees a therapist on Thursdays.", privacyClassification: "Sensitive", withheld: false });

    const assistant = serverStore(inner, { owner: "owner" });
    const theirs = await getMentalModel(assistant, id, { now: later });
    expect(theirs).toMatchObject({ answer: null, withheld: true, evidence: [] });
  });

  it("a Sealed fact is never summarised into a model, whoever refreshes", async () => {
    const inner = new InMemoryStore();
    const owner = govern(inner, { policies: [personalDefaults({ owner: "owner" })], context: () => ({ actor: "owner" }) });
    await owner.addNode(makeNode({ content: { text: "Bank PIN is sealed away." }, privacyClassification: "Sealed", contextualMetadata: { tags: ["x"] } }));
    await owner.addNode(makeNode({ content: { text: "Likes tea." }, contextualMetadata: { tags: ["x"] } }));
    await defineMentalModel(owner, { question: "What about Chris?", scope: { tags: ["x"] } });
    const shown: string[] = [];
    await refreshMentalModels(owner, {
      propose: async (rs) => {
        shown.push(...rs.flatMap((r) => r.facts.map((f) => f.text)));
        return quoting(rs);
      },
      now: later,
      includeSensitive: true,
    });
    expect(shown).toEqual(["Likes tea."]);
  });
});

describe("the MCP tools", () => {
  it("define_mental_model then mental_model: defined, answered by the host's refresh, listed and read", async () => {
    const inner = new InMemoryStore();
    const store = serverStore(inner, { owner: "owner" });
    const t = governanceTools({ store, now: later });
    await t.remember({ text: "Chris ships one release command for the library." });
    const { id } = await t.defineMentalModel({ question: "  What did Chris ship   this week? " });
    expect(await t.mentalModel({ id })).toMatchObject({ question: "What did Chris ship this week?", answer: null, stale: { because: "not answered yet" } });

    await refreshMentalModels(store, { propose: quoting, now: later });
    const read = await t.mentalModel({ id });
    expect(read).toMatchObject({ fresh: true, answer: "Chris ships one release command for the library." });
    expect(Array.isArray(await t.mentalModel({}))).toBe(true);
    await expect(t.mentalModel({ id: "nope" })).rejects.toThrow(/no mental model nope/);
  });
});

describe("portability", () => {
  it("a model, its answers and their evidence travel in the portable export", async () => {
    const source = new InMemoryStore();
    await source.addNode(makeNode({ content: { text: "Prefers decisions over options." }, contextualMetadata: { tags: ["style"] } }));
    const id = await defineMentalModel(source, { question: "How does Chris like to be advised?", scope: { tags: ["style"] } });
    await refreshMentalModels(source, { propose: quoting, now: later });

    const artifact = await exportPortable(new Map([["p", source]]));
    const dest = new InMemoryStore();
    await importPortable(artifact, () => dest);
    const m = await getMentalModel(dest, id, { now: () => new Date("2099-01-01T12:00:00.000Z") });
    expect(m).toMatchObject({ question: "How does Chris like to be advised?", answer: "Prefers decisions over options.", fresh: true });
    expect(m!.evidence).toEqual([expect.objectContaining({ holds: true })]);
    expect(await mentalModelHistory(dest, id)).toHaveLength(1);
  });
});
