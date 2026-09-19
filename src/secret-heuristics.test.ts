import { describe, expect, it } from "vitest";

import { looksSecret, personalDefaults } from "./governance/index.js";
import { makeNode } from "./memory-store-conformance.spec.js";

/**
 * The detector was `password:`-shaped. "my wifi password: hunter2" was caught
 * and hidden; "the wifi password is hunter2" — the way a person actually says
 * it into a memory system — was written Private and handed straight back to the
 * AI. AWS keys, JWTs and bearer tokens walked through as well (Astra R10 +
 * Fable, 2026-09-18).
 *
 * It is still a heuristic and these tests are its stated reach, not a proof of
 * coverage: it catches shapes it knows, and the false positives it accepts are
 * part of the bargain.
 */
describe("looksSecret — the shapes it knows", () => {
  it("catches a secret spoken as a sentence, not only as a label", () => {
    expect(looksSecret("my wifi password: hunter2")).toBe(true); // already caught
    expect(looksSecret("the wifi password is hunter2")).toBe(true);
    expect(looksSecret("The Wi-Fi passphrase was correct-horse-battery-staple")).toBe(true);
    expect(looksSecret("my pin is 4417")).toBe(true);
    expect(looksSecret("his passcode is 0000")).toBe(true);
    expect(looksSecret("the api key is ab12cd34ef56")).toBe(true);
  });

  it("catches an AWS key, a JWT and a bearer token", () => {
    expect(looksSecret("keys are in the deploy notes: AKIAIOSFODNN7EXAMPLE")).toBe(true);
    expect(looksSecret("ASIAY34FZKBOKMUTVV7A is the session key")).toBe(true);
    expect(
      looksSecret("token eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
    ).toBe(true);
    expect(looksSecret("Authorization: Bearer 4f9c2a1de8b7460fa1c3d5e7")).toBe(true);
  });

  it("leaves ordinary sentences about these words alone", () => {
    expect(looksSecret("he forgot his password again and had to reset it")).toBe(false);
    expect(looksSecret("we talked about passwords and password managers")).toBe(false);
    expect(looksSecret("the enamel pin badge on his jacket")).toBe(false);
    expect(looksSecret("she keeps a token of the trip on her desk")).toBe(false);
  });

  it("writes the spoken form Sensitive, so it never reaches the assistant", async () => {
    const policy = personalDefaults({ owner: "chris" });
    const ctx = { actor: "chris", audience: "agent", purpose: "write" as const, now: new Date() };
    const written = await policy.beforeWrite!(makeNode({ content: { text: "the wifi password is hunter2" } }), ctx);
    expect(written.privacyClassification).toBe("Sensitive");
    // And the assistant asking for it gets nothing back.
    const stored = { ...makeNode(), ...written, nodeId: "n1", temporalAnchors: [], validFrom: "2026-01-01T00:00:00.000Z", validTo: null };
    expect(await policy.beforeRead!(stored, { ...ctx, purpose: "recall" })).toBeNull();
  });
});
