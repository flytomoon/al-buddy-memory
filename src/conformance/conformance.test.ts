import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { InMemoryStore } from "../in-memory-store.js";
import { exportPortable } from "../memory-portability.js";
import { detectFormat, fromBlocks, fromPortable, fromRecords, proveRoundTrip } from "./adapters.js";
import { formatReport, grade, scoreConformance } from "./score.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => readFileSync(join(here, "fixtures", name), "utf8");

const base = { encryptionKeyRef: "t", privacyClassification: "Private" as const, retentionTier: "FullRetention" as const, contextualMetadata: {}, decayRate: 0 };

async function governedStore() {
  const store = new InMemoryStore();
  const london = await store.addNode({ ...base, provenance: "UserInput", memoryType: "Experience", content: { text: "Lives in London" }, confidenceWeight: 1, validFrom: "2024-01-01T00:00:00Z" });
  const tokyo = await store.addNode({ ...base, provenance: "UserInput", memoryType: "Experience", content: { text: "Lives in Tokyo" }, confidenceWeight: 1, validFrom: "2026-06-01T00:00:00Z" });
  await store.updateNode(london.nodeId, { validTo: "2026-06-01T00:00:00Z", contextualMetadata: { supersededBy: tokyo.nodeId } });
  await store.addEdge({ sourceNodeId: tokyo.nodeId, targetNodeId: london.nodeId, relationshipType: "Temporal", strength: 1, provenance: "UserAsserted" });
  return store;
}

describe("conformance — the provenance & portability score", () => {
  it("a governed export scores A on every dimension, with a proven round-trip", async () => {
    const artifact = await exportPortable(new Map([["p", await governedStore()]]));
    const input = await fromPortable(artifact);
    expect(input.traits.roundTrip).toBe("lossless");
    const r = scoreConformance(input);
    expect(r.grade).toBe("A");
    expect(Object.fromEntries(r.dimensions.map((d) => [d.key, d.score]))).toEqual({ provenance: 1, temporal: 1, invalidation: 1, retention: 1, confidence: 1, relationships: 1, portability: 1 });
    expect(formatReport(r)).toContain("Grade A");
  });

  it("a confidence outside [0,1] does not count as one", async () => {
    // The scorer claimed "a confidence in [0,1]" and checked only typeof number.
    const artifact = await exportPortable(new Map([["p", await governedStore()]]));
    artifact.projects[0]!.nodes[0]!.confidenceWeight = 9;
    const r = scoreConformance(await fromPortable(artifact));
    expect(r.dimensions.find((d) => d.key === "confidence")?.score).toBe(0.5);
  });

  it("the round-trip proof fails when a node is missing from the re-export", async () => {
    const artifact = await exportPortable(new Map([["p", await governedStore()]]));
    const tampered = { ...artifact, projects: artifact.projects.map((p) => ({ ...p, nodes: p.nodes.slice(1), edges: [] })) };
    // The tampered artifact is self-consistent, so it round-trips; the ORIGINAL against a tampered import must not.
    expect(await proveRoundTrip(tampered)).toBe(true);
    const doubled = { ...artifact, projects: [...artifact.projects, { ...artifact.projects[0]!, project: "q" }] };
    expect(await proveRoundTrip(doubled)).toBe(true);
    expect((await fromPortable({ ...artifact, projects: [{ project: "p", nodes: [], edges: [] }] })).facts).toHaveLength(0);
  });

  it("a block-style agent file scores honestly: blocks without provenance, time, or itemised facts", () => {
    const input = fromBlocks(fixture("blocks-sample.json"));
    expect(input.system).toBe("Block-style agent file (sample_agent)");
    expect(input.facts.map((f) => f.id)).toEqual(["block-0", "block-1"]);
    expect(input.facts[0]!.text).toContain("First name: Priya");
    expect(input.facts.every((f) => f.provenance === null && f.validFrom === null && f.confidence === null)).toBe(true);
    const r = scoreConformance(input);
    const by = Object.fromEntries(r.dimensions.map((d) => [d.key, d.score]));
    expect(by).toMatchObject({ provenance: 0, temporal: 0, invalidation: 0, retention: null, confidence: 0, relationships: 0 });
    expect(by["portability"]).toBeCloseTo(0.67, 2);
    expect(r.grade).toBe("F");
    expect(r.dimensions.find((d) => d.key === "retention")!.reason).toContain("unproven");
  });

  it("a double-encoded agent file (a JSON string holding the document) parses the same", () => {
    const wrapped = JSON.stringify(fixture("blocks-sample.json"));
    expect(fromBlocks(wrapped).facts).toHaveLength(2);
    expect(detectFormat(wrapped)).toBe("blocks");
  });

  it("flat memory records score their timestamps but nothing they do not record", () => {
    const input = fromRecords(fixture("records-sample.json"));
    expect(input.facts).toHaveLength(3);
    expect(input.facts[0]).toMatchObject({ text: "Priya is a marine biologist based in Lisbon", validFrom: "2026-08-01T10:00:00.000000-07:00", provenance: null, confidence: null });
    const r = scoreConformance(input);
    const by = Object.fromEntries(r.dimensions.map((d) => [d.key, d.score]));
    expect(by).toMatchObject({ provenance: 0, temporal: 1, invalidation: 0.5, retention: null, confidence: 0, relationships: 0 });
    expect(by["portability"]).toBeCloseTo(0.67, 2);
    expect(r.grade).toBe("D");
  });

  it("detects the three formats and refuses anything else", () => {
    expect(detectFormat(fixture("blocks-sample.json"))).toBe("blocks");
    expect(detectFormat(fixture("records-sample.json"))).toBe("records");
    expect(detectFormat({ formatVersion: "1.0.0", exportedAt: "x", projects: [], mcp: { entities: [], relations: [] } })).toBe("portable");
    expect(() => detectFormat({ hello: 1 })).toThrow(/could not detect/);
    expect(() => fromRecords({ results: [{ nope: 1 }] })).toThrow(/not a flat memory-records export/);
  });

  it("grades are thresholds on the provable mean", () => {
    expect([grade(0.9), grade(0.75), grade(0.5), grade(0.25), grade(0.1)]).toEqual(["A", "B", "C", "D", "F"]);
    const empty = scoreConformance({ system: "x", format: "portable", facts: [], edges: [], traits: { invalidation: "unknown", schema: { published: false }, roundTrip: "unknown", itemised: false } });
    expect(empty.dimensions.filter((d) => d.score !== null).map((d) => d.key)).toEqual(["portability"]);
    expect(empty.total).toBe(0);
  });
});
