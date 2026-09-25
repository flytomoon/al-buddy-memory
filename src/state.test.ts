/**
 * Current state: "where does X stand now?" answered by one live memory per
 * subject, with every earlier state kept as history.
 *
 * The case that motivated it: asked about the library's release, an assistant
 * recalled "0.5.1 is out; npm is holding it for approval" two releases after
 * 0.7.0 went live. Every status note stayed live forever, and recall ranked by
 * wording alone, so the oldest well-worded note won.
 */
import { describe, expect, it } from "vitest";

import { HybridRetriever } from "./hybrid-retriever.js";
import { InMemoryStore } from "./in-memory-store.js";
import { makeNode } from "./memory-store-conformance.spec.js";
import { SqliteMemoryStore } from "./sqlite-memory-store.js";
import type { MemoryStore } from "./types/memory.js";
import { currentStates, recordState, STATE_TAG, stateHistory, stateKey, statesMentionedIn } from "./state.js";

const at = (d: string) => `2026-09-${d}:00.000Z`;

describe("recordState", () => {
  it("a newer state of the same subject closes the older one, which stays as history", async () => {
    const store = new InMemoryStore();
    const first = await recordState(store, { subject: "al-buddy-memory", aspect: "latest release", text: "0.5.1 is staged on npm, waiting for approval.", at: at("22T18:29") });
    const second = await recordState(store, { subject: "Al Buddy Memory", aspect: "Latest release", text: "0.7.0 is live on npm.", at: at("24T22:45") });

    expect(second.superseded.map((n) => n.nodeId)).toEqual([first.node.nodeId]);
    const now = await currentStates(store);
    expect(now.map((s) => s.text)).toEqual(["0.7.0 is live on npm."]);
    expect(now[0]).toMatchObject({ subject: "Al Buddy Memory", aspect: "Latest release", since: at("24T22:45") });

    const closed = await store.getNode(first.node.nodeId);
    expect(closed?.validTo).toBe(at("24T22:45"));
    expect(closed?.contextualMetadata["supersededBy"]).toBe(second.node.nodeId);

    const history = await stateHistory(store, { subject: "al-buddy-memory", aspect: "latest release" });
    expect(history.map((h) => [h.text, h.until])).toEqual([
      ["0.7.0 is live on npm.", null],
      ["0.5.1 is staged on npm, waiting for approval.", at("24T22:45")],
    ]);
  });

  it("different aspects of one subject are separate states", async () => {
    const store = new InMemoryStore();
    await recordState(store, { subject: "al-buddy-memory", aspect: "latest release", text: "0.7.0 is live.", at: at("24T22:45") });
    await recordState(store, { subject: "al-buddy-memory", aspect: "version Al runs on", text: "Al runs on 0.6.0.", at: at("23T06:44") });
    expect((await currentStates(store)).map((s) => s.text).sort()).toEqual(["0.7.0 is live.", "Al runs on 0.6.0."]);
  });

  it("a state that arrives late never overturns a newer one: it is recorded as already closed", async () => {
    const store = new InMemoryStore();
    const newer = await recordState(store, { subject: "launch", text: "Launched on Tuesday.", at: at("24T10:00") });
    const older = await recordState(store, { subject: "launch", text: "Launch is scheduled.", at: at("20T10:00") });
    expect(older.superseded).toEqual([]);
    expect(older.node.validTo).toBe(at("24T10:00"));
    expect(older.node.contextualMetadata["supersededBy"]).toBe(newer.node.nodeId);
    expect((await currentStates(store)).map((s) => s.text)).toEqual(["Launched on Tuesday."]);
    expect((await stateHistory(store, { subject: "launch" })).map((h) => h.text)).toEqual(["Launched on Tuesday.", "Launch is scheduled."]);
  });

  it("saying the same state again changes nothing", async () => {
    const store = new InMemoryStore();
    const a = await recordState(store, { subject: "launch", text: "Launched on Tuesday.", at: at("24T10:00") });
    const b = await recordState(store, { subject: "launch", text: "  launched on tuesday. ", at: at("24T11:00") });
    expect(b.node.nodeId).toBe(a.node.nodeId);
    expect(b.unchanged).toBe(true);
    expect(await store.listNodes()).toHaveLength(1);
  });

  it("only states are touched: an ordinary fact that mentions the subject is left alone", async () => {
    const store = new InMemoryStore();
    const plain = await store.addNode(makeNode({ content: { text: "al-buddy-memory latest release notes are long." } }));
    await recordState(store, { subject: "al-buddy-memory", aspect: "latest release", text: "0.7.0 is live.", at: at("24T22:45") });
    expect((await store.getNode(plain.nodeId))?.validTo).toBeNull();
  });

  it("a state is an ordinary tagged fact: provenance, privacy and extra tags are the caller's", async () => {
    const store = new InMemoryStore();
    const { node } = await recordState(store, {
      subject: "health",
      text: "Physio twice a week.",
      at: at("24T10:00"),
      provenance: "UserInput",
      privacyClassification: "Sensitive",
      tags: ["personal"],
      contextualMetadata: { source: "chat" },
    });
    expect(node).toMatchObject({ provenance: "UserInput", privacyClassification: "Sensitive", validFrom: at("24T10:00") });
    expect(node.contextualMetadata["tags"]).toEqual(expect.arrayContaining([STATE_TAG, "personal"]));
    expect(node.contextualMetadata["source"]).toBe("chat");
  });

  it("refuses an empty subject or text", async () => {
    const store = new InMemoryStore();
    await expect(recordState(store, { subject: "  ", text: "x" })).rejects.toThrow(/subject/);
    await expect(recordState(store, { subject: "x", text: " " })).rejects.toThrow(/text/);
  });
});

describe("stateKey", () => {
  it("ignores case, spacing and punctuation", () => {
    expect(stateKey({ subject: "Al Buddy-Memory", aspect: "Latest  release" })).toBe(stateKey({ subject: "al-buddy memory", aspect: "latest release" }));
    expect(stateKey({ subject: "x" })).not.toBe(stateKey({ subject: "x", aspect: "y" }));
  });
});

describe("statesMentionedIn", () => {
  it("finds a subject however it is spelled in the text, or by an alias", async () => {
    const store = new InMemoryStore();
    await recordState(store, { subject: "al-buddy-memory", aspect: "latest release", text: "0.7.0 is live.", at: at("24T22:45") });
    await recordState(store, { subject: "Prompts That Kill", aliases: ["PTK"], aspect: "prototypes", text: "Prototypes arrived.", at: at("24T12:00") });
    await recordState(store, { subject: "Games We All Know", aspect: "hosting", text: "Served by Netlify.", at: at("06T20:30") });
    const states = await currentStates(store);

    const said = "Yeah, I wasn't able to release Al Buddy Memory today on LinkedIn. Should we wait till Tuesday?";
    expect(statesMentionedIn(states, said).map((s) => s.text)).toEqual(["0.7.0 is live."]);
    expect(statesMentionedIn(states, "how are the ptk prototypes?").map((s) => s.text)).toEqual(["Prototypes arrived."]);
    expect(statesMentionedIn(states, "where is games hosting now")).toEqual([]);
    expect(statesMentionedIn(states, "where is Games We All Know hosted?").map((s) => s.text)).toEqual(["Served by Netlify."]);
    expect(statesMentionedIn(states, "what's for dinner")).toEqual([]);
  });

  it("a one-word subject must appear as a whole word, not inside another", async () => {
    const store = new InMemoryStore();
    await recordState(store, { subject: "Al", aspect: "version", text: "Runs on 0.6.0.", at: at("24T10:00") });
    const states = await currentStates(store);
    expect(statesMentionedIn(states, "the total is fine")).toEqual([]);
    expect(statesMentionedIn(states, "what version is Al on?").map((s) => s.text)).toEqual(["Runs on 0.6.0."]);
  });
});

describe("recall with freshness", () => {
  it("off by default; on, a newer fact of equal relevance outranks an older one", async () => {
    const store = new InMemoryStore();
    const older = await store.addNode(makeNode({ content: { text: "release status: waiting for approval" }, validFrom: at("20T10:00") }));
    await new Promise((r) => setTimeout(r, 5)); // learned a moment later, never the same millisecond
    const newer = await store.addNode(makeNode({ content: { text: "release status: live everywhere" }, validFrom: at("24T10:00") }));
    // Learned in this order, so the second is the newer one.
    const r = new HybridRetriever(store);
    const plain = await r.recall("release status waiting", { limit: 2 });
    expect(plain[0]?.nodeId).toBe(older.nodeId);
    const fresh = await r.recall("release status waiting", { limit: 2, freshness: 1 });
    expect(fresh.map((n) => n.nodeId)).toEqual([newer.nodeId, older.nodeId]);
  });

  it("freshness never brings in a fact the query did not match", async () => {
    const store = new InMemoryStore();
    await store.addNode(makeNode({ content: { text: "release status: waiting for approval" }, validFrom: at("20T10:00") }));
    await store.addNode(makeNode({ content: { text: "bought groceries" }, validFrom: at("24T10:00") }));
    const hits = await new HybridRetriever(store).recall("release status", { limit: 5, freshness: 1 });
    expect(hits.map((n) => n.content.text)).toEqual(["release status: waiting for approval"]);
  });

  it("rejects a negative or non-finite weight", async () => {
    const r = new HybridRetriever(new InMemoryStore());
    await expect(r.recall("x", { freshness: -1 })).rejects.toThrow(/freshness/);
    await expect(r.recall("x", { freshness: Number.NaN })).rejects.toThrow(/freshness/);
  });
});

describe.each([
  ["InMemoryStore", () => new InMemoryStore() as MemoryStore],
  ["SqliteMemoryStore", () => new SqliteMemoryStore(":memory:") as MemoryStore],
])("states on %s", (_name, make) => {
  it("supersede, arrive late, repeat, and read back as current and history", async () => {
    const store = make();
    await recordState(store, { subject: "al-buddy-memory", aspect: "latest release", text: "0.5.1 staged.", at: at("22T18:29") });
    await recordState(store, { subject: "al-buddy-memory", aspect: "latest release", text: "0.7.0 live.", at: at("24T22:45") });
    await recordState(store, { subject: "al-buddy-memory", aspect: "latest release", text: "0.6.0 live.", at: at("23T06:35") });
    const again = await recordState(store, { subject: "al-buddy-memory", aspect: "latest release", text: "0.7.0 live.", at: at("25T01:00") });
    expect(again.unchanged).toBe(true);
    expect((await currentStates(store)).map((s) => s.text)).toEqual(["0.7.0 live."]);
    expect((await currentStates(store, { at: at("23T00:00") })).map((s) => s.text)).toEqual(["0.5.1 staged."]);
    expect((await stateHistory(store, { subject: "al-buddy-memory", aspect: "latest release" })).map((h) => h.text)).toEqual(["0.7.0 live.", "0.6.0 live.", "0.5.1 staged."]);
  });
});
