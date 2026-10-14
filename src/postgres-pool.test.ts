import { beforeEach, describe, expect, it, vi } from "vitest";

import { PostgresMemoryStore } from "./postgres-memory-store.js";

/**
 * The pool a `connectionString` store makes, with `pg` (now optional, loaded on
 * first use) replaced by a pool that answers every statement and counts what
 * the store asks of it.
 */
const made = vi.hoisted((): { connectionString: string; queries: string[]; ended: number }[] => []);
vi.mock("pg", () => ({
  Pool: class {
    readonly seen: (typeof made)[number];
    constructor(options: { connectionString: string }) {
      this.seen = { connectionString: options.connectionString, queries: [], ended: 0 };
      made.push(this.seen);
    }
    async query(sql: string) {
      this.seen.queries.push(sql);
      return { rows: [{ extversion: "0.8.0" }] };
    }
    async end() { this.seen.ended += 1; }
  },
}));

beforeEach(() => { made.length = 0; });
const url = "postgres://memory.invalid/db";

describe("PostgresMemoryStore from a connectionString", () => {
  it("makes no pool until a call needs one, then one pool however many calls start at once", async () => {
    const store = new PostgresMemoryStore({ tenantId: "t", connectionString: url });
    expect(made).toEqual([]);
    await Promise.all([store.initialize(), store.initialize(), store.initialize()]);
    expect(made.map(p => p.connectionString)).toEqual([url]);
    expect(made[0]!.queries.filter(q => q === "CREATE EXTENSION IF NOT EXISTS vector")).toHaveLength(3);
    await store.close();
    expect(made[0]!.ended).toBe(1);
  });

  it("close() before any call ends nothing, and a call after close() is refused", async () => {
    const store = new PostgresMemoryStore({ tenantId: "t", connectionString: url });
    await store.close();
    await expect(store.initialize()).rejects.toThrow("this store is closed");
    expect(made).toEqual([]);
  });

  it("a call after close() does not make a second pool", async () => {
    const store = new PostgresMemoryStore({ tenantId: "t", connectionString: url });
    await store.initialize();
    await store.close();
    await expect(store.listNodes()).rejects.toThrow("this store is closed");
    expect(made).toHaveLength(1);
  });
});
