/** Browser entry for the demo page: the scorer, the adapters, and a demo store, no Node built-ins. */
import { InMemoryStore } from "../in-memory-store.js";
import { exportPortable } from "../memory-portability.js";
import { fromPortable, toConformanceInput } from "./adapters.js";
import type { ConformanceInput } from "./model.js";
import { formatReport, scoreConformance } from "./score.js";

export { scoreConformance, formatReport, toConformanceInput };

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
