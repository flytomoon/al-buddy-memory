import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as lib from "../../src/index.js";
import { UsageLimitError } from "./answerers.mjs";
import { EVENT_SCHEMA, eventSources, fuseEventSources, sessionExtractor, sessionKey, validateEvents } from "./events.mjs";
import { ingestHistory, recallRounds } from "./memory.mjs";
import { instance } from "./fixture.js";

type Turn = { role: string; content: string };
const turns: Turn[] = [{ role: "user", content: "I moved to Tokyo last Tuesday." }];
const good = { turn: 0, quote: "moved to Tokyo", entity: "Tokyo", aspect: "move", referencedDate: "2023-02-07" };
const OBSERVED = "2023-02-10T00:00:00.000Z";

/** An answerer that replies from a function of the prompt, and counts its calls. */
function fakeAnswerer(reply: (prompt: string, call: number) => string | Error) {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    async complete(prompt: string) {
      const r = reply(prompt, calls++);
      if (r instanceof Error) throw r;
      return { text: r };
    },
  };
}

const dirs: string[] = [];
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), "lme-events-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("event validation: one bad event is dropped and counted, never the session", () => {
  it("keeps verbatim, dated events and drops each bad one with its reason", () => {
    const reply = JSON.stringify([
      good,
      { ...good, quote: "moved to Berlin" },
      { ...good, referencedDate: "2023-02-30" },
      { ...good, turn: 4 },
      { ...good, entity: " " },
      "not an event",
      { ...good, referencedDate: undefined },
    ]);
    const { events, dropped } = validateEvents(reply, turns, OBSERVED);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ observedDate: "2023-02-10", referencedDate: "2023-02-07" });
    expect(events[1].referencedDate).toBeNull();
    expect(dropped.map((d: { index: number; reason: string }) => [d.index, d.reason])).toEqual([
      [1, "quote"],
      [2, "referencedDate"],
      [3, "turn"],
      [4, "entity-aspect"],
      [5, "shape"],
    ]);
  });

  it("reads an array inside a fence or prose, caps at 100, and throws only when there is no array", () => {
    expect(validateEvents("```json\n" + JSON.stringify([good]) + "\n```", turns, OBSERVED).events).toHaveLength(1);
    expect(validateEvents(`Here are the events:\n${JSON.stringify([good])}\nDone.`, turns, OBSERVED).events).toHaveLength(1);
    const many = validateEvents(JSON.stringify(Array.from({ length: 102 }, () => good)), turns, OBSERVED);
    expect([many.events.length, many.dropped.length, many.dropped[0].reason]).toEqual([100, 2, "cap"]);
    expect(validateEvents("[]", turns, OBSERVED)).toEqual({ events: [], dropped: [] });
    expect(() => validateEvents("I could not find any events.", turns, OBSERVED)).toThrow(/invalid JSON/);
    expect(() => validateEvents(JSON.stringify({ events: [good] }), turns, OBSERVED)).toThrow(/array/);
  });
});

describe("the extraction pass", () => {
  const x = instance();
  const tokyo = (prompt: string) => (prompt.includes("Tokyo") ? JSON.stringify([{ turn: 0, quote: "moved to Tokyo", entity: "Tokyo", aspect: "move", referencedDate: null }, { turn: 0, quote: "moved to Kyoto", entity: "Kyoto", aspect: "move", referencedDate: null }]) : "[]");

  it("extracts each unique session once, caches raw replies, and a second run makes no call", async () => {
    const cachePath = join(tempDir(), "events.cache.jsonl");
    const a = fakeAnswerer(tokyo);
    const first = sessionExtractor(a, { cachePath });
    const stats = await first.prepare([x, x], { concurrency: 2 });
    expect(a.calls).toBe(3);
    expect(stats).toMatchObject({ sessions: 3, cachedBefore: 0, called: 3, extracted: 3, failed: [], events: 1, dropped: 1, droppedByReason: { quote: 1 } });
    const rows = readFileSync(cachePath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(rows.every((r) => r.schema === EVENT_SCHEMA && typeof r.text === "string")).toBe(true);

    appendFileSync(cachePath, '{"key": "cut short'); // a run killed mid-write
    const b = fakeAnswerer(() => new Error("must not be called"));
    const second = sessionExtractor(b, { cachePath });
    const again = await second.prepare([x]);
    expect(b.calls).toBe(0);
    expect(again).toMatchObject({ sessions: 3, cachedBefore: 3, called: 0, extracted: 3, events: 1, dropped: 1, unreadableCacheLines: 1 });
    expect(second.lookup(x.haystack_sessions[1], x.haystack_dates[1]).events[0].quote).toBe("moved to Tokyo");
  });

  it("records a failed session, never caches it, and lets its questions run without its events", async () => {
    const cachePath = join(tempDir(), "events.cache.jsonl");
    const extractor = sessionExtractor(fakeAnswerer((p) => (p.includes("Berlin") ? "no events, sorry" : tokyo(p))), { cachePath });
    const stats = await extractor.prepare([x], { concurrency: 1 });
    expect(stats.extracted).toBe(2);
    expect(stats.failed).toHaveLength(1);
    expect(stats.failed[0]).toMatchObject({ sessionId: "answer_x1_2" });
    expect(stats.failed[0].reason).toMatch(/invalid JSON/);
    expect(extractor.lookup(x.haystack_sessions[2], x.haystack_dates[2])).toMatchObject({ events: [], failed: expect.stringMatching(/invalid JSON/) });
    expect(readFileSync(cachePath, "utf8").trim().split("\n")).toHaveLength(2);
    expect(() => sessionExtractor(fakeAnswerer(() => "[]")).lookup(x.haystack_sessions[0], x.haystack_dates[0])).toThrow(/not extracted/);
  });

  it("stops after 3 consecutive failed sessions, and at a usage limit, saying how far it got", async () => {
    const failing = sessionExtractor(fakeAnswerer(() => new Error("timed out")));
    await expect(failing.prepare([x], { concurrency: 1 })).rejects.toMatchObject({ message: expect.stringMatching(/3 consecutive/), attempted: 3, succeeded: 0 });
    const limited = sessionExtractor(fakeAnswerer((_p, call) => (call === 1 ? new UsageLimitError("limit reached") : "[]")));
    await expect(limited.prepare([x], { concurrency: 1 })).rejects.toMatchObject({ attempted: 2, succeeded: 1 });
  });

  it("keys a session by its content and date", () => {
    const s = x.haystack_sessions[0];
    expect(sessionKey(s, x.haystack_dates[0])).toBe(sessionKey(structuredClone(s), x.haystack_dates[0]));
    expect(sessionKey(s, x.haystack_dates[0])).not.toBe(sessionKey(s, x.haystack_dates[1]));
  });
});

describe("the event channel is fused with recall, not put ahead of it", () => {
  const node = (nodeId: string) => ({ nodeId });

  it("adds 1/(60 + rank) per list; ties keep recall's order", () => {
    const hits = ["a", "b", "c"].map(node);
    const fused = fuseEventSources(hits, [{ sourceId: "c", rank: 1 }, { sourceId: "d", rank: 1 }], new Map([["d", node("d")]]));
    expect(fused.map((n: { nodeId: string }) => n.nodeId)).toEqual(["c", "a", "d", "b"]);
    expect(fuseEventSources(hits, [], new Map()).map((n: { nodeId: string }) => n.nodeId)).toEqual(["a", "b", "c"]);
  });

  it("ranks sources by overlap, equal overlaps sharing the mean rank, inside any named period", () => {
    const ev = (sourceId: string, entity: string, aspect: string, date = "2023-02-10") => ({ sourceId, entity, aspect, observedDate: date, referencedDate: null });
    const events = [ev("s1", "Tokyo", "move"), ev("s2", "Tokyo office", "move"), ev("s3", "Tokyo", "food"), ev("s1", "Tokyo", "rent"), ev("s4", "Berlin", "bike"), ev("s5", "Tokyo", "move", "2023-04-01")];
    const ranked = eventSources(events, "When did I move to Tokyo?", [{ from: "2023-02-01T00:00:00Z", to: "2023-03-01T00:00:00Z" }]);
    expect(ranked).toEqual([
      { sourceId: "s1", overlap: 2, rank: 1.5 },
      { sourceId: "s2", overlap: 2, rank: 1.5 },
      { sourceId: "s3", overlap: 1, rank: 3 },
    ]);
    expect(eventSources(events, "Tokyo?", [], 2)).toHaveLength(2);
  });

  it("stores quoted derived records beside untouched raw turns, counts what it dropped, and ranks only source rounds", async () => {
    const x = instance({ question: "What happened in Tokyo in February 2023?" });
    const extractor = sessionExtractor(
      fakeAnswerer((p) =>
        p.includes("Tokyo")
          ? JSON.stringify([
              { turn: 0, quote: "moved to Tokyo", entity: "Tokyo", aspect: "move", referencedDate: "2023-02-10" },
              { turn: 0, quote: "moved to Osaka", entity: "Osaka", aspect: "move", referencedDate: null },
            ])
          : p.includes("Berlin")
            ? "not json"
            : "[]",
      ),
    );
    await extractor.prepare([x]);
    const memory = await ingestHistory(lib, x, { extractEvents: async (session: Turn[], date: string) => extractor.lookup(session, date), store: () => new lib.InMemoryStore() });
    try {
      expect(memory.eventStats).toEqual({ stored: 1, dropped: 1, droppedByReason: { quote: 1 }, sessionsFailed: 1 });
      expect(memory.memories).toBe(9); // raw messages only
      const nodes = await memory.store.listNodes();
      const event = nodes.find((n: { memoryType: string }) => n.memoryType === "Experience")!;
      const source = nodes.find((n: { nodeId: string }) => n.nodeId === (event.contextualMetadata.derivedFrom as string[])[0])!;
      expect(source.content.text).toBe("I just moved to Tokyo for work.");
      expect(event.content.text).toBe("moved to Tokyo");
      expect(event.provenance).toBe("AIInferred");
      const recalled = await recallRounds(memory, x);
      expect(recalled.rounds[0]?.id).toBe("answer_x1_1_1");
      expect(recalled.rounds.every((r: { turns: Turn[] }) => r.turns.every((t) => !t.content.startsWith("moved to")))).toBe(true);
      expect(recalled.eventChannel).toEqual({ sources: 1, notInRecall: 0 });
    } finally {
      memory.store.close?.();
    }
  });

  it("drops an event that quotes an empty, unstored turn instead of failing the question", async () => {
    const x = instance({ haystack_sessions: [[{ role: "user", content: "" }, { role: "assistant", content: "Hi" }], ...instance().haystack_sessions.slice(1)], haystack_session_ids: ["empty", "answer_x1_1", "answer_x1_2"] });
    const extractEvents = async (session: Turn[]) => (session[0].content === "" ? { events: [{ turn: 0, quote: "", entity: "e", aspect: "a", observedDate: "2023-01-05", referencedDate: null }], dropped: [] } : { events: [], dropped: [] });
    const memory = await ingestHistory(lib, x, { extractEvents, store: () => new lib.InMemoryStore() });
    try {
      expect(memory.eventStats).toMatchObject({ stored: 0, dropped: 1, droppedByReason: { "source-not-stored": 1 } });
    } finally {
      memory.store.close?.();
    }
  });
});
