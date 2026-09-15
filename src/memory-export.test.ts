import { describe, expect, it } from "vitest";
import { exportMemoryMarkdown } from "./memory-export.js";
import { SqliteMemoryStore } from "./sqlite-memory-store.js";

function node(text: string) {
  return {
    provenance: "UserInput" as const,
    encryptionKeyRef: "local",
    memoryType: "Experience" as const,
    privacyClassification: "Private" as const,
    retentionTier: "FullRetention" as const,
    content: { text },
    contextualMetadata: {},
    confidenceWeight: 1,
    decayRate: 0,
  };
}

describe("exportMemoryMarkdown", () => {
  it("renders current memories with provenance and a read-only notice", async () => {
    const store = new SqliteMemoryStore(":memory:");
    try {
      await store.addNode(node("Chris lives in Tokyo"));
      const md = await exportMemoryMarkdown(store, "al-buddy");
      expect(md).toContain("Chris lives in Tokyo");
      expect(md).toContain("UserInput"); // provenance is shown (auditable)
      expect(md.toLowerCase()).toContain("read-only");
      expect(md.toLowerCase()).toContain("not read back"); // no tamper path back in
    } finally {
      store.close();
    }
  });

  it("shows superseded memories in a Retired section, preserving history", async () => {
    const store = new SqliteMemoryStore(":memory:");
    try {
      await store.addNode(node("Chris lives in Tokyo"));
      const london = await store.addNode(node("Chris lives in London"));
      await store.updateNode(london.nodeId, { validTo: "2022-06-01T00:00:00.000Z" });

      const md = await exportMemoryMarkdown(store, "al-buddy");
      expect(md).toContain("Retired");
      expect(md).toContain("Chris lives in London");
      // the retired one carries its validity window
      expect(md).toContain("2022-06-01");
    } finally {
      store.close();
    }
  });
});
