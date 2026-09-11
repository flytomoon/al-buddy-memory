/** Browser entry for the demo page: the scorer, the adapters, and a demo store, no Node built-ins. */
import { InMemoryStore } from "../in-memory-store.js";
import { exportPortable } from "../memory-portability.js";
import { fromPortable, toConformanceInput } from "./adapters.js";
import type { ConformanceInput } from "./model.js";
import { formatReport, scoreConformance } from "./score.js";

export { scoreConformance, formatReport, toConformanceInput };

const PEOPLE_FACTS: ReadonlyArray<[string, string, string | null]> = [
  // [text, validFrom, replacedByText]
  ["Lives in Porto", "2024-02-01", "Lives in Lisbon"],
  ["Lives in Lisbon", "2025-09-01", null],
  ["Works at a marine research institute", "2024-02-01", "Works at a marine research institute, leading the deep-reef survey"],
  ["Works at a marine research institute, leading the deep-reef survey", "2026-01-15", null],
  ["Prefers metric units", "2024-02-01", null],
  ["Prefers short answers", "2024-03-10", null],
  ["Training for a free-diving certification", "2025-04-01", "Certified free diver (level 2)"],
  ["Certified free diver (level 2)", "2025-11-20", null],
  ["Bakes sourdough on Sundays", "2024-06-01", null],
  ["Has a cat named Mira", "2024-02-01", null],
  ["Drives a 2016 hatchback", "2024-02-01", "Sold the car; cycles and takes the train"],
  ["Sold the car; cycles and takes the train", "2025-06-01", null],
  ["Allergic to shellfish", "2024-02-01", null],
  ["Reads before bed, mostly non-fiction", "2024-08-01", null],
  ["Planning a trip to the Azores in October", "2026-08-20", null],
  ["Sister lives in Berlin", "2024-02-01", null],
  ["Learning Portuguese, conversational", "2024-05-01", "Speaks Portuguese fluently"],
  ["Speaks Portuguese fluently", "2026-03-01", null],
  ["Uses a standing desk", "2024-09-01", null],
  ["Birthday is in March", "2024-02-01", null],
];

const INFERRED: ReadonlyArray<[string, string, number]> = [
  ["Moved from Porto to Lisbon in late 2025, likely for the survey role", "2025-09-15", 0.8],
  ["Comfortable with early-morning schedules (dives, bakes, reads at night)", "2025-12-01", 0.6],
  ["Values low-carbon transport", "2025-06-15", 0.7],
  ["Probably travels to Berlin around March", "2026-02-01", 0.55],
  ["Prefers written summaries over calls", "2026-04-01", 0.65],
  ["Interested in citizen-science diving apps", "2026-05-01", 0.5],
];

/**
 * A realistic generated store: one person over two and a half years, twenty
 * user-asserted facts of which six were superseded (and say by what), six
 * AI-inferred facts with honest confidence, and relations with provenance.
 * Generated in the page; no real person.
 */
export async function realisticInput(): Promise<ConformanceInput> {
  const store = new InMemoryStore();
  const base = { encryptionKeyRef: "demo", privacyClassification: "Private" as const, retentionTier: "FullRetention" as const, contextualMetadata: {}, decayRate: 0 };
  const byText = new Map<string, string>();
  for (const [text, from] of PEOPLE_FACTS) {
    const n = await store.addNode({ ...base, provenance: "UserInput", memoryType: "Experience", content: { text }, confidenceWeight: 1, validFrom: `${from}T00:00:00Z` });
    byText.set(text, n.nodeId);
  }
  for (const [text, , replacedBy] of PEOPLE_FACTS) {
    if (!replacedBy) continue;
    const successor = PEOPLE_FACTS.find(([t]) => t === replacedBy)!;
    const id = byText.get(text)!;
    await store.updateNode(id, { validTo: `${successor[1]}T00:00:00Z`, contextualMetadata: { supersededBy: byText.get(replacedBy) } });
    await store.addEdge({ sourceNodeId: byText.get(replacedBy)!, targetNodeId: id, relationshipType: "Temporal", strength: 1, provenance: "UserAsserted" });
  }
  for (const [text, from, confidence] of INFERRED) {
    const n = await store.addNode({ ...base, provenance: "AIInferred", memoryType: "Lesson", content: { text }, confidenceWeight: confidence, validFrom: `${from}T00:00:00Z` });
    const anchor = PEOPLE_FACTS[Math.floor(Math.random() * 0)]; // deterministic: first fact
    await store.addEdge({ sourceNodeId: n.nodeId, targetNodeId: byText.get(anchor![0])!, relationshipType: "Reinforcement", strength: confidence, provenance: "AIInferred" });
  }
  return fromPortable(await exportPortable(new Map([["person", store]])), { system: "al-buddy-memory (generated: one person, 2.5 years)" });
}

/** The same three-fact governed store the CLI's --demo scores. */
export async function demoInput(): Promise<ConformanceInput> {
  const store = new InMemoryStore();
  const base = { encryptionKeyRef: "demo", privacyClassification: "Private" as const, retentionTier: "FullRetention" as const, contextualMetadata: {}, decayRate: 0 };
  const london = await store.addNode({ ...base, provenance: "UserInput", memoryType: "Experience", content: { text: "Lives in London" }, confidenceWeight: 1, validFrom: "2024-01-01T00:00:00Z" });
  const tokyo = await store.addNode({ ...base, provenance: "UserInput", memoryType: "Experience", content: { text: "Lives in Tokyo" }, confidenceWeight: 1, validFrom: "2026-06-01T00:00:00Z" });
  await store.updateNode(london.nodeId, { validTo: "2026-06-01T00:00:00Z", contextualMetadata: { supersededBy: tokyo.nodeId } });
  const derived = await store.addNode({ ...base, provenance: "AIInferred", memoryType: "Lesson", content: { text: "Moved from London to Tokyo in mid-2026" }, confidenceWeight: 0.8, validFrom: "2026-06-01T00:00:00Z" });
  await store.addEdge({ sourceNodeId: derived.nodeId, targetNodeId: tokyo.nodeId, relationshipType: "Reinforcement", strength: 0.9, provenance: "AIInferred" });
  await store.addEdge({ sourceNodeId: tokyo.nodeId, targetNodeId: london.nodeId, relationshipType: "Temporal", strength: 1, provenance: "UserAsserted" });
  return fromPortable(await exportPortable(new Map([["demo", store]])), { system: "al-buddy-memory (demo store)" });
}

/** The demo store as a portable export, so the page can show what "A" looks like on the wire. */
export async function demoExport(): Promise<string> {
  const input = await demoInput();
  return JSON.stringify(input, null, 2);
}
