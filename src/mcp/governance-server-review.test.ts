import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { FakeEmbedder } from "../embedder.js";
import { InMemoryStore } from "../in-memory-store.js";
import { SERVER_VERSION, attachGovernanceServer, governanceTools, serverStore, ID_MAX_CHARS, QUERY_MAX_CHARS, REASON_MAX_CHARS } from "./governance-server.js";

/** MCP-surface findings from the 2026-09-22 review, each failing on 0.5.0 first. */

async function connect(store: InMemoryStore | ReturnType<typeof serverStore>) {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const { server } = await attachGovernanceServer({ store });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await (server as { connect(t: unknown): Promise<void> }).connect(s);
  const client = new Client({ name: "t", version: "1" });
  await client.connect(c);
  return client;
}

describe("pin — a rule this assistant could never see is refused, not reported pinned", () => {
  /**
   * "Never ask me what my pin is for the garage" matches the secret heuristic, so
   * the shipped server wrote it Sensitive — hidden from the assistant that pinned
   * it. The tool said "pinned", the rule never reached a prompt, and every
   * re-pin added another hidden copy because the dedupe could not see the first.
   */
  it("refuses up front, writes nothing, and says why", async () => {
    const inner = new InMemoryStore();
    const t = governanceTools({ store: serverStore(inner) });
    const rule = "Never ask me what my pin is for the garage";
    await expect(t.pin({ text: rule })).rejects.toThrow(/secret/i);
    await expect(t.pin({ text: rule })).rejects.toThrow(/secret/i);
    expect(await inner.searchNodes({ tags: ["pinned"], privacyClassification: ["Public", "Private", "Sensitive", "Sealed"] })).toEqual([]);
  });

  it("a pin a custom policy hides from the reader is reported as hidden, not pinned", async () => {
    const { govern } = await import("../governance/governed-store.js");
    const inner = new InMemoryStore();
    const hidesPins = govern(inner, {
      policies: [{ name: "hide-pins", beforeRead: (n) => (n.contextualMetadata["pinned"] === true ? null : n) }],
      context: () => ({ actor: "owner" }),
    });
    const t = governanceTools({ store: hidesPins });
    await expect(t.pin({ text: "Always answer in English" })).rejects.toThrow(/not visible|hidden/i);
  });
});

describe("remember — with an embedder wired, the fact is embedded when it is stored", () => {
  it("a remembered fact is found by meaning straight away", async () => {
    const store = new InMemoryStore();
    const vec = (s: string) => (/tokyo|japan/i.test(s) ? [1, 0] : [0, 1]);
    const t = governanceTools({ store, embedder: new FakeEmbedder("f", 2, vec) });
    const saved = await t.remember({ text: "Moved to Tokyo" });
    expect((await store.listEmbeddings("f")).map((e) => e.nodeId)).toContain(saved.id);
    expect((await t.recall({ query: "Japan" })).map((f) => f.id)).toContain(saved.id);
  });

  it("a fact the audience cannot see is still stored, and remember does not fail on the embedding", async () => {
    const inner = new InMemoryStore();
    const t = governanceTools({ store: serverStore(inner), embedder: new FakeEmbedder("f", 2, () => [1, 0]) });
    await expect(t.remember({ text: "the wifi password is hunter2" })).resolves.toBeTruthy();
    expect(await inner.searchNodes({ privacyClassification: ["Sensitive"] })).toHaveLength(1);
  });
});

describe("invalidate — replacedBy must name a fact", () => {
  it("refuses an id that does not exist, and the fact itself", async () => {
    const t = governanceTools({ store: new InMemoryStore() });
    const f = await t.remember({ text: "Lives in London" });
    await expect(t.invalidate({ id: f.id, replacedBy: "no-such-fact" })).rejects.toThrow(/replacedBy/);
    await expect(t.invalidate({ id: f.id, replacedBy: f.id })).rejects.toThrow(/replacedBy/);
    expect((await t.recall({ query: "London" }))[0]!.current).toBe(true);
  });
});

describe("wire limits on every string the MCP surface accepts", () => {
  it("refuses an oversized reason, replacedBy, id or query", async () => {
    const client = await connect(new InMemoryStore());
    const r = (await client.callTool({ name: "remember", arguments: { text: "Lives in London" } })) as { content: { text: string }[] };
    const id = JSON.parse(r.content.at(-1)!.text).id as string;
    const calls = [
      { name: "invalidate", arguments: { id, reason: "x".repeat(REASON_MAX_CHARS + 1) } },
      { name: "invalidate", arguments: { id, replacedBy: "x".repeat(ID_MAX_CHARS + 1) } },
      { name: "invalidate", arguments: { id: "x".repeat(ID_MAX_CHARS + 1) } },
      { name: "history", arguments: { id: "x".repeat(ID_MAX_CHARS + 1) } },
      { name: "unpin", arguments: { id: "x".repeat(ID_MAX_CHARS + 1) } },
      { name: "recall", arguments: { query: "x".repeat(QUERY_MAX_CHARS + 1) } },
    ];
    for (const call of calls) expect(await client.callTool(call), call.name).toMatchObject({ isError: true });
    // At the limit is fine.
    expect(await client.callTool({ name: "invalidate", arguments: { id, reason: "x".repeat(REASON_MAX_CHARS) } })).not.toMatchObject({ isError: true });
  });
});

describe("the handshake version is the package version", () => {
  /** The 0.4.2 and 0.4.3 tags both announced "0.4.1": it was a literal. */
  it("reads it from package.json", async () => {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };
    expect(SERVER_VERSION).toBe(pkg.version);
    const client = await connect(new InMemoryStore());
    expect(client.getServerVersion()?.version).toBe(pkg.version);
  });
});
