import { readFileSync } from "node:fs";
import { join } from "node:path";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";

import { exportPortable } from "./memory-portability.js";
import { makeNode } from "./memory-store-conformance.spec.js";
import { SqliteMemoryStore } from "./sqlite-memory-store.js";
import {
  ANCHOR_EVENTS,
  EDGE_PROVENANCES,
  MEMORY_NODE_TYPES,
  MEMORY_PROVENANCES,
  PRIVACY_CLASSIFICATIONS,
  RELATIONSHIP_TYPES,
  RETENTION_TIERS,
} from "./types/memory.js";

/**
 * The published schema is a promise to every other implementation. It had
 * drifted: no PendingDeletion, no Conceptual — so the reference user's own
 * export (283 Conceptual edges) failed the reference schema, and nothing
 * checked. Two guards: the schema's enums ARE the runtime enums, and a real
 * export containing every value validates.
 */
const schema = JSON.parse(readFileSync(join(import.meta.dirname, "..", "docs", "portable-format.schema.json"), "utf8"));
const node = schema.$defs.node.properties;
const edge = schema.$defs.edge.properties;

describe("the published portable-format schema", () => {
  it("lists exactly the values the library can write", () => {
    expect(node.provenance.enum).toEqual([...MEMORY_PROVENANCES]);
    expect(node.privacyClassification.enum).toEqual([...PRIVACY_CLASSIFICATIONS]);
    expect(node.retentionTier.enum).toEqual([...RETENTION_TIERS]);
    expect(node.temporalAnchors.items.properties.event.enum).toEqual([...ANCHOR_EVENTS]);
    expect(edge.relationshipType.enum).toEqual([...RELATIONSHIP_TYPES]);
    expect(edge.provenance.enum).toEqual([...EDGE_PROVENANCES]);
  });

  it("accepts a real export that uses every one of them", async () => {
    const store = new SqliteMemoryStore(":memory:");
    const ids: string[] = [];
    const cells = Math.max(MEMORY_NODE_TYPES.length, MEMORY_PROVENANCES.length, PRIVACY_CLASSIFICATIONS.length, RETENTION_TIERS.length);
    for (let i = 0; i < cells; i++) {
      const n = await store.addNode(
        makeNode({
          memoryType: MEMORY_NODE_TYPES[i % MEMORY_NODE_TYPES.length]!,
          provenance: MEMORY_PROVENANCES[i % MEMORY_PROVENANCES.length]!,
          privacyClassification: PRIVACY_CLASSIFICATIONS[i % PRIVACY_CLASSIFICATIONS.length]!,
          retentionTier: RETENTION_TIERS[i % RETENTION_TIERS.length]!,
          content: { text: `fact ${i}` },
        }),
      );
      ids.push(n.nodeId);
    }
    await store.updateNode(ids[0]!, { validTo: new Date().toISOString() });
    for (const [i, relationshipType] of RELATIONSHIP_TYPES.entries()) {
      await store.addEdge({
        sourceNodeId: ids[i % ids.length]!,
        targetNodeId: ids[(i + 1) % ids.length]!,
        relationshipType,
        strength: 0.5,
        provenance: EDGE_PROVENANCES[i % EDGE_PROVENANCES.length]!,
      });
    }
    const artifact = await exportPortable(new Map([["p", store]]));
    store.close();

    const ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(ajv);
    const valid = ajv.validate(schema, JSON.parse(JSON.stringify(artifact)));
    expect(ajv.errors ?? []).toEqual([]);
    expect(valid).toBe(true);
    expect(artifact.projects[0]!.edges.map((e) => e.relationshipType).sort()).toEqual([...RELATIONSHIP_TYPES].sort());
  });
});
