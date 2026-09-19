import { describe, expect, it } from "vitest";

import { consolidate, listConsolidations, undoConsolidation } from "./consolidation.js";
import { MemoryAudit, type AuditSink } from "./governance/audit.js";
import { govern } from "./governance/governed-store.js";
import { SqliteMemoryStore } from "./sqlite-memory-store.js";
import type { MemoryStore } from "./types/memory.js";
import { InMemoryStore } from "./in-memory-store.js";
import { makeNode } from "./memory-store-conformance.spec.js";

/**
 * Facts captured in one millisecond, restored into an empty store. (Rewriting
 * an existing fact's creation anchor is refused — history is append-only — so
 * the collision is built rather than forged.)
 */
async function capturedTogether(store: MemoryStore, texts: string[], iso: string): Promise<string[]> {
  const scratch = new InMemoryStore();
  const ids: string[] = [];
  for (const text of texts) {
    const node = await scratch.addNode(makeNode({ content: { text } }));
    await store.restoreNode({ ...node, validFrom: iso, temporalAnchors: [{ timestamp: iso, event: "created" }] });
    ids.push(node.nodeId);
  }
  return ids;
}

async function seed(store: MemoryStore, texts: string[]) {
  const ids: string[] = [];
  for (const t of texts) ids.push((await store.addNode(makeNode({ content: { text: t } }))).nodeId);
  return ids;
}

describe("consolidate — sleep-time derivation that never touches the raw", () => {
  it("reads recent raw, writes derived facts as NEW nodes linked to their sources, and marks the raw as read", async () => {
    const store = new InMemoryStore();
    const [a, b] = await seed(store, ["He moved to Portland in June.", "His new office is downtown Portland."]);
    const report = await consolidate(store, {
      since: "2000-01-01T00:00:00Z",
      model: "test-model",
      propose: async (raw) => [{ text: "He lives and works in Portland.", sourceNodeIds: raw.map((r) => r.nodeId), confidence: 0.8 }],
    });
    expect(report).toMatchObject({ read: 2, proposed: 1, written: 1, refused: [] });
    const derived = await store.getNode(report.derivedNodeIds[0]!);
    expect(derived?.provenance).toBe("AIInferred");
    expect(derived?.content.text).toBe("He lives and works in Portland.");
    // The pair, not an order: two captures in the same millisecond have no
    // chronological order to assert (the pass's own order is tested below).
    expect((derived?.contextualMetadata["derivedFrom"] as string[]).slice().sort()).toEqual([a, b].sort());
    expect(derived?.confidenceWeight).toBe(0.8);
    const edges = await store.getEdges(derived!.nodeId);
    expect(edges.map((e) => e.targetNodeId).sort()).toEqual([a, b].sort());
    // raw untouched in content; marked as read by an anchor, not rewritten
    const rawA = await store.getNode(a!);
    expect(rawA?.content.text).toBe("He moved to Portland in June.");
    expect(rawA?.temporalAnchors.some((t) => t.event === "summarized")).toBe(true);
  });

  it("does not re-read what a pass already consolidated, and never derives from derived", async () => {
    const store = new InMemoryStore();
    await seed(store, ["fact one"]);
    const propose = async (raw: { nodeId: string }[]) => raw.map((r) => ({ text: "derived from " + r.nodeId, sourceNodeIds: [r.nodeId] }));
    const first = await consolidate(store, { since: "2000-01-01T00:00:00Z", model: "m", propose });
    const second = await consolidate(store, { since: "2000-01-01T00:00:00Z", model: "m", propose });
    expect(first.written).toBe(1);
    expect(second.read).toBe(0); // the raw is marked; the derived node is AIInferred and skipped
  });

  it("refuses a proposal with no sources or with a source outside the pass — a derived fact must rest on raw", async () => {
    const store = new InMemoryStore();
    await seed(store, ["x"]);
    const report = await consolidate(store, {
      since: "2000-01-01T00:00:00Z", model: "m",
      propose: async () => [{ text: "orphan", sourceNodeIds: [] }, { text: "ghost", sourceNodeIds: ["nope"] }, { text: "", sourceNodeIds: ["nope"] }],
    });
    expect(report.written).toBe(0);
    expect(report.refused.map((r) => r.why)).toEqual([expect.stringContaining("no source"), expect.stringContaining("not in this pass"), "empty"]);
  });

  it("dry run proposes and counts but writes nothing", async () => {
    const store = new InMemoryStore();
    const [a] = await seed(store, ["raw"]);
    const report = await consolidate(store, { since: "2000-01-01T00:00:00Z", model: "m", dryRun: true, propose: async () => [{ text: "d", sourceNodeIds: [a!] }] });
    expect(report.written).toBe(1);
    expect(report.derivedNodeIds).toEqual([]);
    expect((await store.searchNodes({ limit: 10 })).length).toBe(1);
    expect((await store.getNode(a!))?.temporalAnchors.some((t) => t.event === "summarized")).toBe(false);
  });
});

describe.each([
  ["InMemoryStore", () => new InMemoryStore() as MemoryStore],
  ["SqliteMemoryStore", () => new SqliteMemoryStore(":memory:") as MemoryStore],
])("review and undo a consolidation pass — %s", (_label, makeStore) => {
  const at = (iso: string) => () => new Date(iso);
  async function twoNights(store: MemoryStore) {
    const [a] = await seed(store, ["He said he hates cilantro."]);
    const one = await consolidate(store, { since: "2000-01-01T00:00:00Z", model: "m", now: at("2026-09-13T09:00:00Z"),
      propose: async (raw) => [{ text: "He dislikes cilantro.", sourceNodeIds: [raw[0]!.nodeId] }] });
    const [b] = await seed(store, ["He ordered extra cilantro, joking."]);
    const two = await consolidate(store, { since: "2000-01-01T00:00:00Z", model: "m", now: at("2026-09-14T09:00:00Z"),
      propose: async (raw) => [{ text: "He loves cilantro now.", sourceNodeIds: [raw[0]!.nodeId] }] });
    return { a: a!, b: b!, one, two };
  }

  it("refuses an undo without a reason", async () => {
    const store = makeStore();
    await twoNights(store);
    await expect(undoConsolidation(store, "2026-09-14T09:00:00.000Z", { reason: "  " })).rejects.toThrow(/needs a reason/);
  });

  it("lists every pass newest first, with each fact's evidence", async () => {
    const store = makeStore();
    const { a, b } = await twoNights(store);
    const runs = await listConsolidations(store);
    expect(runs.map((r) => r.consolidatedAt)).toEqual(["2026-09-14T09:00:00.000Z", "2026-09-13T09:00:00.000Z"]);
    expect(runs[0]!.facts).toEqual([expect.objectContaining({ text: "He loves cilantro now.", derivedFrom: [b], retractedAt: null, retraction: null })]);
    expect(runs[1]!.facts[0]).toMatchObject({ text: "He dislikes cilantro.", derivedFrom: [a] });
  });

  it("retracts one night's conclusions without deleting them or touching the other night", async () => {
    const store = makeStore();
    const { one, two } = await twoNights(store);
    const report = await undoConsolidation(store, "2026-09-14T09:00:00.000Z", { now: at("2026-09-14T10:00:00Z"), reason: "He was joking about the cilantro.", by: "Chris via console" });
    expect(report).toEqual({ retracted: two.derivedNodeIds, alreadyRetracted: [] });

    // Nodes get their real creation time as validFrom; ask about a later instant.
    const standing = await store.searchNodes({ validAt: "2100-01-01T00:00:00Z" });
    const texts = standing.map((n) => n.content.text);
    expect(texts).toContain("He dislikes cilantro.");
    expect(texts).not.toContain("He loves cilantro now.");

    // still in the history, marked when it was withdrawn
    const retracted = await store.getNode(two.derivedNodeIds[0]!);
    expect(retracted?.validTo).toBe("2026-09-14T10:00:00.000Z");
    const listed = (await listConsolidations(store))[0]!.facts[0]!;
    expect(listed.retractedAt).toBe("2026-09-14T10:00:00.000Z");
    // the record says it was an undo, by whom, and why — not just that it stopped being true
    expect(listed.retraction).toEqual({ at: "2026-09-14T10:00:00.000Z", by: "undoConsolidation (Chris via console)", reason: "He was joking about the cilantro." });
    expect(retracted?.content.text).toBe("He loves cilantro now."); // the words themselves are untouched
    expect(await store.getNode(one.derivedNodeIds[0]!)).toMatchObject({ validTo: null });
  });

  it("is safe to repeat, and does not hand the same raw back to tomorrow's pass", async () => {
    const store = makeStore();
    await twoNights(store);
    await undoConsolidation(store, "2026-09-14T09:00:00.000Z", { now: at("2026-09-14T10:00:00Z"), reason: "wrong" });
    const again = await undoConsolidation(store, "2026-09-14T09:00:00.000Z", { now: at("2026-09-14T10:05:00Z"), reason: "wrong again" });
    expect(again.retracted).toEqual([]);
    expect(again.alreadyRetracted).toHaveLength(1);
    // the second undo did not overwrite the first undo's record
    expect((await listConsolidations(store))[0]!.facts[0]!.retraction?.reason).toBe("wrong");
    const next = await consolidate(store, { since: "2000-01-01T00:00:00Z", model: "m", propose: async () => [] });
    expect(next.read).toBe(0);
  });
});

/**
 * CI caught this and a fast laptop did not: two captures inside one millisecond
 * have no chronological order, so whatever the pass did with them depended on
 * the machine. It has to be a total order — the pass reads the same facts in
 * the same sequence tonight and tomorrow night, and `maxRaw` always cuts in the
 * same place.
 */
describe("consolidate — a pass reads in a defined order, collisions included", () => {
  it("replays oldest first and settles same-millisecond captures by id, both stores alike", async () => {
    for (const store of [new InMemoryStore(), new SqliteMemoryStore(":memory:")] as MemoryStore[]) {
      // The collision the CI machine produced by accident, on purpose.
      const ids = await capturedTogether(store, ["one", "two", "three", "four"], "2026-09-14T00:00:00.000Z");

      const seen: string[][] = [];
      for (let i = 0; i < 2; i++) {
        seen.push([]);
        await consolidate(store, {
          since: "2000-01-01T00:00:00Z",
          model: "m",
          dryRun: true, // nothing written, so the second pass reads the same four
          propose: async (raw) => {
            seen[i] = raw.map((r) => r.nodeId);
            return [];
          },
        });
      }
      expect(seen[0]).toEqual([...ids].sort()); // ids ascending: the mirror of the stores' newest-first
      expect(seen[1]).toEqual(seen[0]); // and the same every night
      (store as { close?: () => void }).close?.();
    }
  });
});

/**
 * Three ways a pass could quietly fail to be a pass, all reported on 2026-09-18
 * (Astra R11 + R16) and all reproduced here first.
 */
describe("consolidate — the whole pass, and only what the pass wrote", () => {
  it("reads today's facts even when the store holds thousands of older, more confident ones", async () => {
    const store = new InMemoryStore();
    const scratch = new InMemoryStore();
    const old = new Date(Date.now() - 30 * 86_400_000).toISOString();
    // 5,100 older facts at full confidence — the read was capped at 5,000 and
    // ordered by confidence, so nothing recent ever reached the `since` filter.
    for (let i = 0; i < 5_100; i++) {
      const n = await scratch.addNode(makeNode({ content: { text: `an old fact ${i}` } }));
      await store.restoreNode({ ...n, validFrom: old, temporalAnchors: [{ timestamp: old, event: "created" }] });
    }
    const today = new Date(Date.now() - 60_000).toISOString();
    for (let i = 0; i < 10; i++) {
      await store.addNode(makeNode({ content: { text: `something he said today ${i}` }, confidenceWeight: 0.6 }));
    }

    const report = await consolidate(store, {
      since: today,
      model: "m",
      dryRun: true,
      propose: async (raw) => {
        expect(raw.every((r) => r.text.includes("today"))).toBe(true);
        return [];
      },
    });
    expect(report.read).toBe(10);
  });

  it("reviews and undoes a whole pass, including a fact that has since been archived", async () => {
    const store = new InMemoryStore();
    const [a] = await seed(store, ["he cycles to work"]);
    const at = "2026-09-17T02:00:00.000Z";
    await consolidate(store, {
      since: "2000-01-01T00:00:00Z",
      model: "m",
      now: () => new Date(at),
      propose: async () => [{ text: "he commutes by bike", sourceNodeIds: [a!] }],
    });
    const derivedId = (await listConsolidations(store))[0]!.facts[0]!.nodeId;
    // Cold storage is still the person's memory: the pass wrote it, so the
    // pass has to be able to take it back.
    await store.updateNode(derivedId, { retentionTier: "Archived" }, "archived");

    const runs = await listConsolidations(store);
    expect(runs[0]?.facts.map((f) => f.nodeId)).toEqual([derivedId]);
    const report = await undoConsolidation(store, at, { reason: "wrong inference", by: "Chris" });
    expect(report.retracted).toEqual([derivedId]);
    expect((await store.getNode(derivedId))?.validTo).not.toBeNull();
  });

  it("does not leave a conclusion standing whose evidence it could not record", async () => {
    const store = new InMemoryStore();
    const [a, b] = await seed(store, ["raw one", "raw two"]);
    const report = await consolidate(store, {
      since: "2000-01-01T00:00:00Z",
      model: "m",
      propose: async () => {
        // The source goes while the model is thinking — the review's repro.
        await store.deleteNode(a!);
        return [{ text: "a conclusion resting on a fact that is gone", sourceNodeIds: [a!, b!] }];
      },
    });
    expect(report.written).toBe(0);
    expect(report.refused.map((r) => r.why).join(" ")).toMatch(/evidence/i);
    const standing = (await store.searchNodes({})).filter((n) => n.content.text.startsWith("a conclusion"));
    // Never deleted — but never left standing on evidence nobody can check.
    expect(standing.every((n) => n.validTo !== null)).toBe(true);
  });

  /**
   * Two of the 2026-09-18 fixes did not compose, found by GPT-6-Astra on
   * 2026-09-19. The correctness merge retracts a derived fact whose evidence
   * could not be recorded; the release merge latches a failed audit sink so the
   * store refuses every later change. When the audit sink is what failed, the
   * compensating retraction is a change — so it was refused, consolidate threw,
   * and the conclusion stayed LIVE with one of its two evidence edges.
   *
   * Bypassing the latch would undo the other fix, so the order is inverted
   * instead: a derived fact is written already retracted and only stands once
   * all of its evidence is recorded. There is then nothing to compensate — the
   * failure mode is a withdrawn conclusion, not an unsupported one.
   */
  it("does not leave a conclusion standing when the audit trail dies mid-pass", async () => {
    const inner = new InMemoryStore();
    const [a, b] = await seed(inner, ["raw one", "raw two"]);
    let writes = 0;
    const audit: AuditSink = {
      record(event) {
        // The sink survives the derived fact and dies on its first evidence edge.
        if (event.purpose === "write" && ++writes === 2) throw new Error("ENOSPC: no space left on device");
      },
    };
    const store = govern(inner, { policies: [], context: () => ({ actor: "owner" }), audit });

    await expect(
      consolidate(store, {
        since: "2000-01-01T00:00:00Z",
        model: "m",
        propose: async () => [{ text: "a conclusion whose evidence broke the trail", sourceNodeIds: [a!, b!] }],
      }),
    ).rejects.toThrow(/audit/i);

    const derived = (await inner.listNodes()).find((n) => n.provenance === "AIInferred");
    expect(derived).toBeDefined();
    // THE DEFECT at cce9cf9: validTo was null — the conclusion stood, unretracted,
    // on one of the two edges it claims to rest on.
    expect(derived?.validTo).not.toBeNull();
    expect((await inner.getEdges(derived!.nodeId)).length).toBeLessThan(2);
  });

  it("stands a derived fact up only once all of its evidence is recorded", async () => {
    const inner = new InMemoryStore();
    const [a, b] = await seed(inner, ["raw one", "raw two"]);
    const audit = new MemoryAudit();
    const store = govern(inner, { policies: [], context: () => ({ actor: "owner" }), audit });

    const report = await consolidate(store, {
      since: "2000-01-01T00:00:00Z",
      model: "m",
      propose: async () => [{ text: "a conclusion that rests on both", sourceNodeIds: [a!, b!] }],
    });

    expect(report.written).toBe(1);
    const derived = await inner.getNode(report.derivedNodeIds[0]!);
    expect(derived?.validTo).toBeNull();
    expect(derived?.contextualMetadata["retraction"]).toBeUndefined();
    expect(await inner.getEdges(derived!.nodeId)).toHaveLength(2);
    // Every step of it is on the trail, and the fact only became current at the end.
    const forDerived = audit.events.filter((e) => e.nodeIds.includes(derived!.nodeId));
    expect(forDerived.at(-1)?.purpose).toBe("invalidate"); // the validity change that stood it up
  });
});
