#!/usr/bin/env node
// al-buddy-memory conformance <export.json> [--format portable|blocks|records] [--json]
// al-buddy-memory conformance --demo        score a small governed store, for comparison
// al-buddy-memory verify-audit <audit.jsonl> [--head <hash>]
//   check a hash-chained audit log; the HMAC key, if the log has one, comes from
//   AL_BUDDY_MEMORY_AUDIT_KEY (never the command line, which lands in shell history)
import { readFileSync } from "node:fs";
import { InMemoryStore, exportPortable, verifyAuditChain } from "../dist/index.js";
import { toConformanceInput, scoreConformance, formatReport, fromPortable } from "../dist/conformance/index.js";

const args = process.argv.slice(2);
const cmd = args[0];
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const has = (name) => args.includes(name);

if (cmd === "verify-audit") {
  if (!args[1]) {
    console.error("usage: al-buddy-memory verify-audit <audit.jsonl> [--head <hash>]");
    process.exit(2);
  }
  const key = process.env.AL_BUDDY_MEMORY_AUDIT_KEY;
  const result = await verifyAuditChain(args[1], { ...(key ? { key } : {}), ...(flag("--head") ? { head: flag("--head") } : {}) });
  if (result.ok) console.log(`intact: ${result.count} events, head ${result.head}`);
  else console.error(result.line > 0 ? `BROKEN at line ${result.line} of ${result.count}: ${result.reason}` : `NOT VERIFIED: ${result.reason}`);
  process.exit(result.ok ? 0 : 1);
}

if (cmd !== "conformance") {
  console.error("usage: al-buddy-memory conformance <export.json> [--format portable|blocks|records] [--json]\n       al-buddy-memory conformance --demo\n       al-buddy-memory verify-audit <audit.jsonl> [--head <hash>]");
  process.exit(2);
}

async function demoInput() {
  const store = new InMemoryStore();
  const base = { encryptionKeyRef: "demo", privacyClassification: "Private", retentionTier: "FullRetention", contextualMetadata: {}, decayRate: 0 };
  const london = await store.addNode({ ...base, provenance: "UserInput", memoryType: "Experience", content: { text: "Lives in London" }, confidenceWeight: 1, validFrom: "2024-01-01T00:00:00Z" });
  const tokyo = await store.addNode({ ...base, provenance: "UserInput", memoryType: "Experience", content: { text: "Lives in Tokyo" }, confidenceWeight: 1, validFrom: "2026-06-01T00:00:00Z" });
  await store.updateNode(london.nodeId, { validTo: "2026-06-01T00:00:00Z", contextualMetadata: { supersededBy: tokyo.nodeId } });
  const derived = await store.addNode({ ...base, provenance: "AIInferred", memoryType: "Lesson", content: { text: "Moved from London to Tokyo in mid-2026" }, confidenceWeight: 0.8, validFrom: "2026-06-01T00:00:00Z" });
  await store.addEdge({ sourceNodeId: derived.nodeId, targetNodeId: tokyo.nodeId, relationshipType: "Reinforcement", strength: 0.9, provenance: "AIInferred" });
  await store.addEdge({ sourceNodeId: tokyo.nodeId, targetNodeId: london.nodeId, relationshipType: "Temporal", strength: 1, provenance: "UserAsserted" });
  return fromPortable(await exportPortable(new Map([["demo", store]])), { system: "al-buddy-memory (demo store)" });
}

try {
  const input = has("--demo") ? await demoInput() : await toConformanceInput(readFileSync(args[1], "utf8"), flag("--format"));
  const report = scoreConformance(input);
  if (has("--json")) console.log(JSON.stringify({ ...report, notes: input.traits.notes ?? [] }, null, 2));
  else {
    console.log(formatReport(report));
    if (input.traits.notes?.length) console.log("\nNotes:\n" + input.traits.notes.map((n) => `- ${n}`).join("\n"));
  }
} catch (err) {
  console.error(`conformance: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
