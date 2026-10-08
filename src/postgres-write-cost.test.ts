import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { PostgresMemoryStore } from "./postgres-memory-store.js";
import { InMemoryStore } from "./in-memory-store.js";
import { govern } from "./governance/governed-store.js";
import { storeAudit } from "./governance/audit.js";
// Plain JS shared with the benchmark (bench/postgres-writes/run.mjs).
import { BLOCK, OPERATIONS, countingClient, median, seedTenant } from "../bench/postgres-writes/seed.mjs";

/**
 * A write on the Postgres store reads and writes the rows it acts on, not the
 * tenant's graph. It used to rebuild the whole tenant per write, so a large
 * tenant could not take writes at all. Two tenants, 1,000 and 20,000 facts,
 * shaped alike block by block, take the same writes on the same blocks: the
 * database must return exactly the same rows for each, and the median time
 * must stay within a bounded ratio.
 */
const SMALL = 1_000;
const LARGE = 20_000;
const REPS = 9;
const MAX_RATIO = 3;

let db: PGlite;
beforeAll(async () => { db = new PGlite({ extensions: { vector } }); await db.waitReady; });
afterAll(async () => { await db.close(); });

async function tenant(size: number) {
  const { client, tally } = countingClient(db);
  const store = new PostgresMemoryStore({ tenantId: `cost-${size}`, client, indexedDimensions: 3 });
  await store.initialize();
  const blocks = await seedTenant(db, store.tenantId, size, InMemoryStore);
  const governed = govern(store, { policies: [{ name: "allow-erase", beforeErase: () => true }], context: () => ({ actor: "bench" }), audit: storeAudit(store) });
  return { size, store, governed, tally, blocks };
}

describe("PostgresMemoryStore — a write's cost does not grow with the tenant", () => {
  it(`reads the same rows, in comparable time, at ${SMALL} and ${LARGE} facts`, async () => {
    const small = await tenant(SMALL);
    const large = await tenant(LARGE);
    expect(SMALL / BLOCK).toBeGreaterThan(1 + REPS * OPERATIONS.length);
    // Block 0 warms both: the first audited write walks the chain once per store object.
    for (const t of [small, large]) await t.governed.updateNode(t.blocks[0].facts[9], { confidenceWeight: 0.2 });

    const report: Record<string, { rows: number[]; queries: number[]; ms: number[] }> = {};
    let next = 1;
    for (const op of OPERATIONS) {
      const rows = [0, 0];
      const queries = [0, 0];
      const ms: number[][] = [[], []];
      for (let r = 0; r < REPS; r++) {
        const block = next++;
        // Interleaved, so a burst of load on this machine lands on both sizes.
        for (const [side, t] of [small, large].entries()) {
          const before = { ...t.tally };
          const start = performance.now();
          await op.run(t, t.blocks[block], block);
          ms[side]!.push(performance.now() - start);
          rows[side]! += t.tally.rows - before.rows;
          queries[side]! += t.tally.queries - before.queries;
        }
      }
      report[op.name] = { rows, queries, ms: ms.map(median) };
    }
    const ratios = Object.fromEntries(Object.entries(report).map(([name, r]) => [name, r.ms[1]! / r.ms[0]!]));
    // On failure, this is what to read.
    const detail = JSON.stringify({ report, ratios }, null, 1);
    for (const [name, r] of Object.entries(report)) {
      expect(r.rows[1], `${name}: rows returned\n${detail}`).toBe(r.rows[0]);
      expect(r.queries[1], `${name}: queries sent\n${detail}`).toBe(r.queries[0]);
      expect(ratios[name], `${name}: median time ratio\n${detail}`).toBeLessThan(MAX_RATIO);
    }
  }, 600_000);
});
