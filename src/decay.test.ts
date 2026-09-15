import { describe, expect, it } from "vitest";

import { DECAY_FLOOR, effectiveConfidence, lastTouched } from "./decay.js";

const day = 86_400_000;
const now = Date.parse("2026-09-01T00:00:00Z");
const node = (ageDays: number, confidence = 0.8, decayRate = 0.01, extra: { event: "reinforced" | "modified" | "recalled"; ageDays: number }[] = []) => ({
  confidenceWeight: confidence,
  decayRate,
  validFrom: new Date(now - ageDays * day).toISOString(),
  temporalAnchors: [
    { timestamp: new Date(now - ageDays * day).toISOString(), event: "created" as const },
    ...extra.map((e) => ({ timestamp: new Date(now - e.ageDays * day).toISOString(), event: e.event })),
  ],
});

describe("effectiveConfidence", () => {
  it("prefers the fresher of two equally confident facts", () => {
    expect(effectiveConfidence(node(1), now)).toBeGreaterThan(effectiveConfidence(node(60), now));
  });
  it("resets the clock when a fact is reinforced or modified, not when it is merely recalled", () => {
    const old = node(200);
    const reinforced = node(200, 0.8, 0.01, [{ event: "reinforced", ageDays: 2 }]);
    const recalled = node(200, 0.8, 0.01, [{ event: "recalled", ageDays: 2 }]);
    expect(effectiveConfidence(reinforced, now)).toBeGreaterThan(effectiveConfidence(old, now));
    expect(effectiveConfidence(recalled, now)).toBe(effectiveConfidence(old, now));
  });
  it("never buries an old truth — the multiplier floors at half", () => {
    expect(effectiveConfidence(node(3650), now)).toBe(0.8 * DECAY_FLOOR);
  });
  it("leaves a node with no decay rate exactly as confident as stored", () => {
    expect(effectiveConfidence(node(500, 0.9, 0), now)).toBe(0.9);
  });
  it("lastTouched is the latest of created/reinforced/modified", () => {
    const n = node(100, 0.8, 0.01, [{ event: "modified", ageDays: 10 }]);
    expect(lastTouched(n)).toBe(now - 10 * day);
  });
});

describe("compareRecency is a total order, even over legacy anchors", () => {
  it("sorts anything without a real instant after everything with one, consistently", async () => {
    const { compareRecency } = await import("./decay.js");
    const { instantMs } = await import("./instant.js");
    expect(Number.isNaN(instantMs("2025-06-01T12:00:00"))).toBe(true); // no zone: no guessing
    expect(Number.isNaN(instantMs("1"))).toBe(true);
    expect(instantMs("2026-01-01t00:00:00z")).toBe(Date.UTC(2026, 0, 1));
    const node = (id: string, at: string) => ({ nodeId: id, validFrom: at, temporalAnchors: [{ timestamp: at, event: "created" as const }] }) as never;
    const nodes = [
      node("a", "junk"), node("b", "2026-01-01T00:00:00-01:00"), node("c", "2025-01-01T00:00:00.000Z"),
      node("d", "also junk"), node("e", "2025-06-01T12:00:00"), node("f", "2026-01-01t00:00:00z"),
    ];
    for (const x of nodes) for (const y of nodes) {
      expect(Math.sign(compareRecency(x, y)) + 0).toBe(-Math.sign(compareRecency(y, x)) + 0); // +0: no -0 vs 0
      for (const z of nodes) if (compareRecency(x, y) < 0 && compareRecency(y, z) < 0) expect(compareRecency(x, z)).toBeLessThan(0);
    }
    expect([...nodes].sort(compareRecency).map((n: { nodeId: string }) => n.nodeId)).toEqual(["b", "f", "c", "e", "d", "a"]);
  });
});
