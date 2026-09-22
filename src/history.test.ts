import { describe, expect, it } from "vitest";
import { buildSnapshotAsOf, mutableState, nodeAsOf } from "./history.js";
import type { MemoryNode, NodeVersion } from "./types/memory.js";

const node = (overrides: Partial<MemoryNode> = {}): MemoryNode => ({
  nodeId: "00000000-0000-4000-8000-000000000001",
  provenance: "UserInput",
  encryptionKeyRef: "k",
  memoryType: "Belief",
  privacyClassification: "Private",
  retentionTier: "FullRetention",
  content: { text: "lives here" },
  contextualMetadata: { nested: { value: 1 } },
  temporalAnchors: [{ timestamp: "2026-01-01T00:00:00.000Z", event: "created" }],
  validFrom: "2026-01-01T00:00:00.000Z",
  validTo: null,
  confidenceWeight: 1,
  decayRate: 0,
  ...overrides,
});

const version = (before: ReturnType<typeof mutableState>, after: ReturnType<typeof mutableState>): NodeVersion => ({
  versionId: "00000000-0000-4000-8000-000000000002",
  nodeId: "00000000-0000-4000-8000-000000000001",
  recordedAt: "2026-02-01T00:00:00.000Z",
  event: "modified",
  before,
  after,
});

describe("transaction-history reconstruction", () => {
  it("copies mutable metadata and reconstructs inclusive as-of states", () => {
    const current = node({ validFrom: "2026-03-01T00:00:00.000Z", temporalAnchors: [
      { timestamp: "2026-01-01T00:00:00.000Z", event: "created" },
      { timestamp: "2026-02-01T00:00:00.000Z", event: "modified" },
    ] });
    const source = node();
    const before = mutableState(source);
    const v = version(before, mutableState(current));
    (before.contextualMetadata.nested as { value: number }).value = 9;
    expect((source.contextualMetadata.nested as { value: number }).value).toBe(1);
    expect(nodeAsOf(current, [v], "2026-01-31T23:59:59.999Z").node?.validFrom).toBe("2026-01-01T00:00:00.000Z");
    expect(nodeAsOf(current, [v], v.recordedAt).node?.validFrom).toBe("2026-03-01T00:00:00.000Z");
  });

  it("reads versions in time order even when the store holds them in another order", () => {
    // Re-importing over an existing fact: restoreNode records a "restored"
    // version NOW, then the artifact's older versions are inserted after it, so
    // insertion order is not time order.
    const jan = mutableState(node());
    const feb = { ...jan, validFrom: "2026-02-15T00:00:00.000Z" };
    const mar = { ...jan, validFrom: "2026-03-15T00:00:00.000Z" };
    const current = node({ validFrom: mar.validFrom });
    const late: NodeVersion = { ...version(feb, mar), versionId: "00000000-0000-4000-8000-000000000003", recordedAt: "2026-03-01T00:00:00.000Z", event: "restored" };
    const early: NodeVersion = { ...version(jan, feb), recordedAt: "2026-02-01T00:00:00.000Z" };
    expect(nodeAsOf(current, [late, early], "2026-02-10T00:00:00.000Z").node?.validFrom).toBe(feb.validFrom);
    expect(nodeAsOf(current, [late, early], "2026-01-10T00:00:00.000Z").node?.validFrom).toBe(jan.validFrom);
  });

  it("calls a state exact only when each later change has its own version, not merely as many", () => {
    // A modified anchor on 1 March with no version, and an unrelated modified
    // version on 1 April: counting events says "exact"; the 1 March change is
    // still unrecorded, so a read before it cannot be trusted.
    const current = node({ temporalAnchors: [
      { timestamp: "2026-01-01T00:00:00.000Z", event: "created" },
      { timestamp: "2026-03-01T00:00:00.000Z", event: "modified" },
    ] });
    const stray: NodeVersion = { ...version(mutableState(current), mutableState(current)), recordedAt: "2026-04-01T00:00:00.000Z" };
    expect(nodeAsOf(current, [stray], "2026-02-01T00:00:00.000Z").exact).toBe(false);
    const matched: NodeVersion = { ...stray, recordedAt: "2026-03-01T00:00:00.000Z" };
    expect(nodeAsOf(current, [matched], "2026-02-01T00:00:00.000Z").exact).toBe(true);
  });

  it("reports missing pre-history honestly and filters later edges", () => {
    const current = node({ temporalAnchors: [
      { timestamp: "2026-01-01T00:00:00.000Z", event: "created" },
      { timestamp: "2026-03-01T00:00:00.000Z", event: "modified" },
    ] });
    const snap = buildSnapshotAsOf([current], [{
      edgeId: "e", sourceNodeId: current.nodeId, targetNodeId: current.nodeId,
      createdAt: "2026-03-01T00:00:00.000Z", relationshipType: "Conceptual", strength: 1, provenance: "UserAsserted",
    }], new Map(), "2026-02-01T00:00:00Z");
    expect(snap.inexact).toEqual([current.nodeId]);
    expect(snap.edges).toEqual([]);
    expect(snap.asOf).toBe("2026-02-01T00:00:00.000Z");
  });
});
