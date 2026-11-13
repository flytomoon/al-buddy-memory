import { describe, expect, it } from "vitest";
import * as lib from "../../src/index.js";
import { eventSources, sessionExtractor, validateEvents } from "./events.mjs";
import { ingestHistory, recallRounds } from "./memory.mjs";
import { instance } from "./fixture.js";

describe("write-time event prototype", () => {
  it("requires an exact source quote and an absolute valid referenced date", () => {
    const turns = [{ role: "user", content: "I moved to Tokyo last Tuesday." }];
    const good = [{ turn: 0, quote: "moved to Tokyo", entity: "Tokyo", aspect: "move", referencedDate: "2023-02-07" }];
    expect(validateEvents(JSON.stringify(good), turns, "2023-02-10T00:00:00.000Z")[0]).toMatchObject({ observedDate: "2023-02-10", referencedDate: "2023-02-07" });
    expect(() => validateEvents(JSON.stringify([{ ...good[0], quote: "moved to Berlin" }]), turns, "2023-02-10T00:00:00.000Z")).toThrow(/quote/);
    expect(() => validateEvents(JSON.stringify([{ ...good[0], referencedDate: "2023-02-30" }]), turns, "2023-02-10T00:00:00.000Z")).toThrow(/referencedDate/);
  });

  it("stores derived records with their raw source and gathers source rounds by entity and date", async () => {
    const x = instance({ question: "What happened in Tokyo in February 2023?" });
    const answerer = { complete: async () => ({ text: JSON.stringify([{ turn: 0, quote: "moved to Tokyo", entity: "Tokyo", aspect: "move", referencedDate: "2023-02-10" }]) }) };
    const extract = sessionExtractor(answerer);
    const memory = await ingestHistory(lib, x, { extractEvents: async (session: { content: string }[], date: string) => session[0]?.content.includes("Tokyo") ? extract(session, date) : [] });
    try {
      const nodes = await memory.store.listNodes();
      const event = nodes.find((n) => n.memoryType === "Experience")!;
      const source = nodes.find((n) => n.nodeId === (event.contextualMetadata.derivedFrom as string[])[0])!;
      expect(source.content.text).toBe("I just moved to Tokyo for work.");
      expect(event.content.text).toBe("moved to Tokyo");
      expect(event.contextualMetadata.event).toMatchObject({ observedDate: "2023-02-10", referencedDate: "2023-02-10" });
      expect((await recallRounds(memory, x)).rounds[0]?.id).toBe("answer_x1_1_1");
      expect(eventSources(memory.events, "Tokyo in March 2023", [{ from: "2023-03-01T00:00:00Z", to: "2023-04-01T00:00:00Z" }])).toEqual([]);
    } finally { memory.store.close(); }
  });
});
