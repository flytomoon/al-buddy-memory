import { describe, expect, it } from "vitest";

import { InMemoryStore } from "../in-memory-store.js";
import { PINNED_HEADER } from "../pinned.js";
import { MemoryAudit } from "../governance/audit.js";
import { PIN_MAX_CHARS, REMEMBER_MAX_CHARS, attachGovernanceServer, governanceTools, serverStore } from "./governance-server.js";

const clock = (iso: string) => () => new Date(iso);

describe("governance MCP tools — every answer carries provenance and validity", () => {
  it("remember → recall returns provenance, validFrom, current=true, confidence", async () => {
    const store = new InMemoryStore();
    const t = governanceTools({ store, now: clock("2026-09-10T12:00:00Z") });
    const saved = await t.remember({ text: "Chris prefers Pacific time in reports", provenance: "UserInput" });
    expect(saved).toMatchObject({ provenance: "UserInput", validFrom: "2026-09-10T12:00:00.000Z", validTo: null, current: true, confidence: 1, supersededBy: null });
    const found = await t.recall({ query: "Pacific" });
    expect(found.map((f) => f.id)).toEqual([saved.id]);
  });

  it("invalidate closes validity, keeps the record, names the successor; recall hides it unless asked", async () => {
    const store = new InMemoryStore();
    const t = governanceTools({ store, now: clock("2026-09-10T12:00:00Z") });
    const london = await t.remember({ text: "Lives in London" });
    const tokyo = await t.remember({ text: "Lives in Tokyo" });
    const later = governanceTools({ store, now: clock("2026-09-11T00:00:00Z") });
    const closed = await later.invalidate({ id: london.id, replacedBy: tokyo.id, reason: "moved" });
    expect(closed).toMatchObject({ id: london.id, validTo: "2026-09-11T00:00:00.000Z", current: false, supersededBy: tokyo.id });
    expect(await store.getNode(london.id)).not.toBeNull();
    const current = await later.recall({ query: "Lives" });
    expect(current.map((f) => f.text)).toEqual(["Lives in Tokyo"]);
    const all = await later.recall({ query: "Lives", includeSuperseded: true });
    expect(all.map((f) => f.text).sort()).toEqual(["Lives in London", "Lives in Tokyo"]);
  });

  it("invalidate is idempotent and refuses unknown ids; remember refuses empty text", async () => {
    const t = governanceTools({ store: new InMemoryStore() });
    await expect(t.invalidate({ id: "nope" })).rejects.toThrow(/no fact nope/);
    await expect(t.remember({ text: "   " })).rejects.toThrow(/text is required/);
    const a = await t.remember({ text: "x" });
    const once = await t.invalidate({ id: a.id });
    const twice = await t.invalidate({ id: a.id });
    expect(twice.validTo).toBe(once.validTo);
  });

  it("pin / pinned / unpin ride the same store", async () => {
    const t = governanceTools({ store: new InMemoryStore() });
    const p = await t.pin({ text: "Al has no gender", label: "identity" });
    expect((await t.pinned()).rendered).toContain("[identity] Al has no gender");
    expect(await t.unpin({ id: p.nodeId })).toEqual({ unpinned: true });
    expect((await t.pinned()).blocks).toHaveLength(0);
  });
});

/**
 * The "governance MCP server" ran on the raw store: no policy, no audit
 * (review 2026-09-14, Fable §2.4). The shipped server now serves a governed
 * handle whose audience is the AI client, so the owner's own policy applies.
 */
describe("the shipped server's store", () => {
  it("classifies a secret the AI writes, keeps it out of the AI's recall, and audits every call", async () => {
    const audit = new MemoryAudit();
    const inner = new InMemoryStore();
    const t = governanceTools({ store: serverStore(inner, { owner: "owner", audit }) });

    const secret = await t.remember({ text: "the deploy password: hunter2-staging" });
    await t.remember({ text: "prefers Pacific time" });
    expect((await inner.getNode(secret.id))?.privacyClassification).toBe("Sensitive");

    const recalled = await t.recall({ query: "password" });
    expect(recalled).toEqual([]);
    expect((await t.recall({ query: "Pacific" })).map((f) => f.text)).toEqual(["prefers Pacific time"]);
    expect(audit.events.some((e) => e.outcome === "hidden" && e.nodeIds.includes(secret.id))).toBe(true);
    expect(audit.events.every((e) => e.audience === "mcp-client")).toBe(true);
  });

  it("a hidden secret never takes the place of a fact the AI may see (no probing by page count)", async () => {
    const inner = new InMemoryStore();
    const owner = governanceTools({ store: inner });
    for (let i = 0; i < 12; i++) await owner.remember({ text: `password: hunter-${i}` }); // raw store: written Private...
    for (const n of await inner.listNodes()) await inner.updateNode(n.nodeId, { privacyClassification: "Sensitive" }); // ...and made Sensitive
    await owner.remember({ text: "password managers are allowed at work" });
    const ai = governanceTools({ store: serverStore(inner, { owner: "owner" }) });
    expect((await ai.recall({ query: "password", limit: 1 })).map((f) => f.text)).toEqual(["password managers are allowed at work"]);
  });
});

/**
 * The invalidate-never-overwrite thesis depends on the CLIENT calling
 * `invalidate`, and nothing ever told it to. "I live in Tokyo" … "actually I
 * moved to Berlin" … "where do I live?" left both facts current, with nothing
 * saying they conflict — the scenario a reader hits in minute two (Fable 5.1
 * MCP-surface review, 2026-09-19).
 */
describe("remember answers 'what might this replace?'", () => {
  it("hands back the current facts the new one may be correcting", async () => {
    const t = governanceTools({ store: new InMemoryStore(), now: clock("2026-09-10T12:00:00Z") });
    const tokyo = await t.remember({ text: "Lives in Tokyo" });
    expect(tokyo.mayConflictWith).toEqual([]); // nothing to conflict with yet
    const berlin = await t.remember({ text: "Lives in Berlin" });
    expect(berlin.mayConflictWith).toEqual([{ id: tokyo.id, text: "Lives in Tokyo", validFrom: tokyo.validFrom }]);
    // A suggestion, never an action: Tokyo is still current until the client says otherwise.
    expect((await t.recall({ query: "Lives" })).map((f) => f.text).sort()).toEqual(["Lives in Berlin", "Lives in Tokyo"]);
  });

  it("only suggests facts that are still current — a retired one is not re-offered", async () => {
    const t = governanceTools({ store: new InMemoryStore(), now: clock("2026-09-10T12:00:00Z") });
    const tokyo = await t.remember({ text: "Lives in Tokyo" });
    await t.invalidate({ id: tokyo.id, reason: "moved" });
    const berlin = await t.remember({ text: "Lives in Berlin" });
    expect(berlin.mayConflictWith).toEqual([]);
  });

  it("strips tokens of two characters or fewer, so stop-words do not fill the slots", async () => {
    const t = governanceTools({ store: new InMemoryStore() });
    await t.remember({ text: "A thing happened in the car on a Tuesday" }); // shares only ≤2-char words
    const job = await t.remember({ text: "Works at Acme as of today" });
    expect(job.mayConflictWith).toEqual([]);
    const employer = await t.remember({ text: "Works at Globex now" });
    expect(employer.mayConflictWith.map((c) => c.text)).toEqual(["Works at Acme as of today"]);
  });

  it("suggests at most three, and never the fact just written", async () => {
    const store = new InMemoryStore();
    const t = governanceTools({ store });
    for (let i = 0; i < 6; i++) await t.remember({ text: `Prefers coffee variety ${i}` });
    const newest = await t.remember({ text: "Prefers coffee black" });
    expect(newest.mayConflictWith).toHaveLength(3);
    expect(newest.mayConflictWith.map((c) => c.id)).not.toContain(newest.id);
  });

  /**
   * Measured on the governed path against 300 distractors, 2026-09-19. "Lives in
   * Berlin" put "Lives in Tokyo" first at relevance 0.2310 — and then two
   * "The deploy script lives in tools/deploy-N.sh and needs sudo" lines at
   * 0.0578, a quarter of the top, matching on "lives" alone. Three suggestions
   * of which two are obviously junk reads as a broken feature, so a candidate
   * must score at least half the best one. The best candidate is always kept:
   * the store's ranking, not this floor, decides what is first.
   */
  it("drops candidates far below the best one — a long fact sharing one common word is not a conflict", async () => {
    const store = new InMemoryStore();
    const t = governanceTools({ store });
    await t.remember({ text: "Lives in Tokyo" });
    for (let i = 0; i < 5; i++) await t.remember({ text: `The deploy script lives in tools/deploy-${i}.sh and needs sudo before it will run` });
    const berlin = await t.remember({ text: "Lives in Berlin" });
    expect(berlin.mayConflictWith.map((c) => c.text)).toEqual(["Lives in Tokyo"]);
  });

  it("keeps every candidate when they are all as good as each other", async () => {
    const store = new InMemoryStore();
    const t = governanceTools({ store });
    await t.remember({ text: "Prefers coffee in the morning" });
    await t.remember({ text: "Prefers coffee after lunch" });
    const black = await t.remember({ text: "Prefers coffee black" });
    expect(black.mayConflictWith.map((c) => c.text).sort()).toEqual(["Prefers coffee after lunch", "Prefers coffee in the morning"]);
  });

  it("says nothing when the text has no word longer than two characters", async () => {
    const t = governanceTools({ store: new InMemoryStore() });
    await t.remember({ text: "is it so" });
    expect((await t.remember({ text: "is it so" })).mayConflictWith).toEqual([]);
  });

  /**
   * The instruction budget is 512 characters and full; tool DESCRIPTIONS sit
   * outside it, so this is where the client is told what to do with a suggestion.
   */
  it("the remember tool description tells the client to invalidate what stopped being true", async () => {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const { server } = await attachGovernanceServer({ store: new InMemoryStore() });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await (server as { connect: (t: unknown) => Promise<void> }).connect(serverSide);
    const client = new Client({ name: "test", version: "1" });
    await client.connect(clientSide);
    const remember = (await client.listTools()).tools.find((t) => t.name === "remember");
    expect(remember?.description).toMatch(/mayConflictWith/);
    expect(remember?.description).toMatch(/invalidate any that stopped being true/);
    await client.close();
  });
});

/**
 * `remember.text` and `pin.text` were bare `z.string()`. A 10 MB "fact" was
 * accepted, indexed, and returned in full on every recall that matched it —
 * and a 10 MB PIN would ride every prompt (Fable 5.1 MCP-surface review,
 * 2026-09-19). The wire is where the cap belongs: a host calling the tools
 * directly is its own trust boundary, an MCP client is not.
 */
describe("a fact has a length, and it is not ten megabytes", () => {
  const wire = async () => {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const inner = new InMemoryStore();
    const { server } = await attachGovernanceServer({ store: serverStore(inner, { owner: "owner" }) });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await (server as { connect: (t: unknown) => Promise<void> }).connect(serverSide);
    const client = new Client({ name: "test", version: "1" });
    await client.connect(clientSide);
    return { client, inner };
  };

  it(`refuses a fact over ${REMEMBER_MAX_CHARS} characters and a pin over ${PIN_MAX_CHARS}, and stores neither`, async () => {
    const { client, inner } = await wire();
    const tooLong = await client.callTool({ name: "remember", arguments: { text: "x".repeat(REMEMBER_MAX_CHARS + 1) } });
    const fatPin = await client.callTool({ name: "pin", arguments: { text: "y".repeat(PIN_MAX_CHARS + 1) } });
    expect(tooLong).toMatchObject({ isError: true });
    expect(fatPin).toMatchObject({ isError: true });
    expect(await inner.listNodes()).toHaveLength(0); // refused, not truncated and stored
    await client.close();
  });

  it("accepts a fact and a pin right at the cap", async () => {
    const { client, inner } = await wire();
    await client.callTool({ name: "remember", arguments: { text: "x".repeat(REMEMBER_MAX_CHARS) } });
    await client.callTool({ name: "pin", arguments: { text: "y".repeat(PIN_MAX_CHARS) } });
    expect(await inner.listNodes()).toHaveLength(2);
    await client.close();
  });
});

/**
 * The pinned tier existed and the shipped product never showed it to anybody:
 * nothing surfaced it, and the 512-character instruction budget (measured at
 * 507) had no room to explain a seventh tool. So it rides the FIRST recall of a
 * connection instead, where the client is already reading facts — no instruction
 * characters spent (Fable 5.1 MCP-surface review, 2026-09-19).
 */
describe("pins reach the client", () => {
  it("the pinned block rides the first recall of a connection, and only the first", async () => {
    const store = new InMemoryStore();
    const t = governanceTools({ store });
    await t.pin({ text: "Al has no gender — say Al or they.", label: "identity" });
    await t.remember({ text: "Prefers coffee black" });

    const first = await t.pinnedPreamble();
    expect(first).toContain("[identity] Al has no gender");
    expect(first).toContain(PINNED_HEADER);
    expect(await t.pinnedPreamble()).toBe(""); // spent
  });

  it("an empty tier does not spend the one delivery — a pin made later still rides the next recall", async () => {
    const store = new InMemoryStore();
    const t = governanceTools({ store });
    expect(await t.pinnedPreamble()).toBe("");
    await t.pin({ text: "never a yes-person", label: "tone" });
    expect(await t.pinnedPreamble()).toContain("never a yes-person");
    expect(await t.pinnedPreamble()).toBe("");
  });

  it("over the wire: the first recall returns the pins beside the facts, the second only the facts", async () => {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const inner = new InMemoryStore();
    const store = serverStore(inner, { owner: "owner" });
    await governanceTools({ store }).pin({ text: "Al has no gender — say Al or they.", label: "identity" });
    await governanceTools({ store }).remember({ text: "Prefers coffee black" });

    const { server } = await attachGovernanceServer({ store });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await (server as { connect: (t: unknown) => Promise<void> }).connect(serverSide);
    const client = new Client({ name: "test", version: "1" });
    await client.connect(clientSide);

    const first = (await client.callTool({ name: "recall", arguments: { query: "coffee" } })) as { content: { text: string }[] };
    expect(first.content).toHaveLength(2);
    expect(first.content[0]!.text).toContain("[identity] Al has no gender");
    expect(JSON.parse(first.content[1]!.text)[0].text).toBe("Prefers coffee black");

    const second = (await client.callTool({ name: "recall", arguments: { query: "coffee" } })) as { content: { text: string }[] };
    expect(second.content).toHaveLength(1);
    expect(JSON.parse(second.content[0]!.text)[0].text).toBe("Prefers coffee black");
    await client.close();
  });
});

/**
 * The handshake promises memory "shared across their assistants" and there were
 * no receipts: `recall` dropped `origin` on the floor, and `invalidate` and
 * `unpin` recorded nothing about who did it. Two assistants on one store, and
 * neither could tell what the other had written or retired (Fable 5.1
 * MCP-surface review, 2026-09-19).
 */
describe("receipts — which assistant wrote a fact, and which retired it", () => {
  const desktop = { app: "claude-desktop", appVersion: "1.2.3", via: "mcp" };
  const cursor = { app: "cursor", via: "mcp" };

  it("remember and recall carry the writing app", async () => {
    const store = new InMemoryStore();
    const t = governanceTools({ store, origin: () => desktop });
    const fact = await t.remember({ text: "Lives in Tokyo" });
    expect(fact).toMatchObject({ origin: desktop, retiredBy: null });
    expect((await t.recall({ query: "Tokyo" }))[0]).toMatchObject({ origin: desktop, retiredBy: null });
  });

  it("invalidate stamps who retired it without overwriting who wrote it", async () => {
    const store = new InMemoryStore();
    const written = await governanceTools({ store, origin: () => desktop }).remember({ text: "Lives in Tokyo" });
    const other = governanceTools({ store, origin: () => cursor });
    const closed = await other.invalidate({ id: written.id, reason: "moved" });
    expect(closed).toMatchObject({ origin: desktop, retiredBy: cursor });
    expect((await other.recall({ query: "Tokyo", includeSuperseded: true }))[0]).toMatchObject({ origin: desktop, retiredBy: cursor });
  });

  it("unpin records which assistant unpinned it, beside who pinned it", async () => {
    const store = new InMemoryStore();
    const pinned = await governanceTools({ store, origin: () => desktop }).pin({ text: "never a yes-person", label: "tone" });
    await governanceTools({ store, origin: () => cursor }).unpin({ id: pinned.nodeId });
    const node = await store.getNode(pinned.nodeId);
    expect(node?.contextualMetadata["origin"]).toEqual(desktop);
    expect(node?.contextualMetadata["retiredBy"]).toEqual(cursor);
  });

  it("a host that knows no origin reports null, not an empty object", async () => {
    const store = new InMemoryStore();
    const t = governanceTools({ store });
    const fact = await t.remember({ text: "no origin known" });
    expect(fact.origin).toBeNull();
    const closed = await t.invalidate({ id: fact.id });
    expect(closed.retiredBy).toBeNull();
    expect((await store.getNode(fact.id))?.contextualMetadata["retiredBy"]).toBeUndefined();
  });
});

/**
 * 0.4.1 (founder, 2026-09-15). Claude Desktop connected to this server five times
 * and never called a tool — nothing a client doesn't know to use gets used — and
 * nothing recorded which assistant a fact came from. The server now tells every
 * client how to use it (MCP `instructions`), and stamps each fact it writes with
 * the app that wrote it, taken from the connection handshake, not from the model.
 */
describe("the server tells clients how to use it, and records which app wrote each fact", () => {
  it("sends instructions at initialize and stamps remember and pin with the client app", async () => {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const inner = new InMemoryStore();
    const { server } = await attachGovernanceServer({ store: serverStore(inner, { owner: "owner" }) });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await (server as { connect: (t: unknown) => Promise<void> }).connect(serverSide);
    const client = new Client({ name: "claude-ai", version: "1.2.3" });
    await client.connect(clientSide);

    const instructions = client.getInstructions() ?? "";
    // The claim is that the whole thing survives a client that reads 512
    // characters — so assert the whole thing, not a sample of it. Listing three
    // of the six rules is how a 637-character string passed a green suite while
    // `invalidate` and `pin` fell outside the window (measured 2026-09-18).
    expect(instructions.length).toBeLessThanOrEqual(512);
    for (const rule of [/recall/, /remember/, /secrets/, /invalidate/, /\bpin\b/]) expect(instructions).toMatch(rule);

    await client.callTool({ name: "remember", arguments: { text: "prefers Pacific time in reports" } });
    await client.callTool({ name: "pin", arguments: { text: "never a yes-person", label: "tone" } });
    const written = await inner.listNodes();
    expect(written).toHaveLength(2);
    for (const n of written) expect(n.contextualMetadata["origin"]).toEqual({ app: "claude-ai", appVersion: "1.2.3", via: "mcp" });
    await client.close();
  });

  it("the transport-free tools stamp whatever origin their host supplies, and nothing when it supplies none", async () => {
    const inner = new InMemoryStore();
    const bare = await governanceTools({ store: inner }).remember({ text: "no origin known" });
    expect((await inner.getNode(bare.id))?.contextualMetadata["origin"]).toBeUndefined();
    const tools = governanceTools({ store: inner, origin: () => ({ agent: "al-buddy", channel: "telegram", model: "claude-sonnet-5" }) });
    const stamped = await tools.remember({ text: "stamped" });
    expect((await inner.getNode(stamped.id))?.contextualMetadata["origin"]).toEqual({ agent: "al-buddy", channel: "telegram", model: "claude-sonnet-5" });
  });
});
