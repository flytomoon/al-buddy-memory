import { describe, expect, it } from "vitest";
import { buildSourceProvenance, readSourceProvenance } from "./provenance.js";

describe("source provenance round trip", () => {
  it("builds metadata carrying the originating exchange and reads it back", () => {
    const meta = buildSourceProvenance(
      { user: "I moved to Tokyo", assistant: "Noted!" },
      "2026-07-17T10:00:00.000Z",
    );
    const view = readSourceProvenance(meta);
    expect(view).toEqual({
      user: "I moved to Tokyo",
      assistant: "Noted!",
      at: "2026-07-17T10:00:00.000Z",
    });
  });

  it("preserves any existing metadata keys (e.g. source label, tags)", () => {
    const meta = buildSourceProvenance(
      { user: "hi", assistant: "hey" },
      "2026-07-17T10:00:00.000Z",
      { source: "auto-curated", tags: ["greeting"] },
    );
    expect(meta["source"]).toBe("auto-curated");
    expect(meta["tags"]).toEqual(["greeting"]);
    expect(readSourceProvenance(meta)?.user).toBe("hi");
  });

  it("truncates very long turns so a huge message can't bloat the store", () => {
    const long = "x".repeat(5000);
    const meta = buildSourceProvenance(
      { user: long, assistant: long },
      "2026-07-17T10:00:00.000Z",
    );
    const view = readSourceProvenance(meta)!;
    expect(view.user.length).toBeLessThanOrEqual(2000);
    expect(view.assistant.length).toBeLessThanOrEqual(2000);
  });

  it("returns undefined for metadata without provenance (e.g. user-stated facts)", () => {
    expect(readSourceProvenance({})).toBeUndefined();
    expect(readSourceProvenance({ source: "user" })).toBeUndefined();
    expect(readSourceProvenance({ sourceExchange: "not an object" })).toBeUndefined();
  });
});
