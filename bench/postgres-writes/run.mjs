// Usage: npm run build && node bench/postgres-writes/run.mjs [sizes=1000,10000,100000] [reps=20]
//
// What one write costs on the Postgres store as a tenant grows. Each size is a
// fresh tenant in in-process PGlite (with pgvector), seeded straight into the
// tables (seed.mjs) in blocks of ten facts that all have the same shape, then
// every write in OPERATIONS runs `reps` times, each on its own block. Reported
// per write and size: median and p90 milliseconds, and the rows the database
// returned per call (counted at the query client).
//
// What it does not measure: a networked Postgres server (PGlite runs in this
// process, single-connection, so there is no round-trip latency and no
// concurrency), seeding itself, or reads that answer about a whole tenant
// (listNodes, snapshots, eraseWhere's selection), which grow with it by
// design. Writes it is fair to compare across sizes, because each touches a
// block shaped like every other.
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { InMemoryStore, PostgresMemoryStore, govern, storeAudit } from "../../dist/index.js";
import { BLOCK, OPERATIONS, countingClient, median, seedTenant } from "./seed.mjs";
import { RESULTS_DIR, isoDate, resultPath, round4, runInfo, writeJson } from "../lib/run-info.mjs";

const sizes = (process.argv[2] ?? "1000,10000,100000").split(",").map(Number);
const reps = Number(process.argv[3] ?? 20);
if (!Number.isInteger(reps) || reps < 1) throw new Error("reps must be a positive integer");
if (sizes.some((n) => !Number.isInteger(n) || n < BLOCK * 2 || n % BLOCK !== 0)) throw new Error(`sizes must be multiples of ${BLOCK}, at least ${BLOCK * 2}`);
const info = runInfo();

const p90 = (values) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * 0.9))];
const results = [];
for (const size of sizes) {
  const db = new PGlite({ extensions: { vector } });
  await db.waitReady;
  const { client, tally } = countingClient(db);
  const store = new PostgresMemoryStore({ tenantId: `bench-${size}`, client, indexedDimensions: 3 });
  await store.initialize();
  const t0 = performance.now();
  const blocks = await seedTenant(db, store.tenantId, size, InMemoryStore);
  const seedS = (performance.now() - t0) / 1000;
  const governed = govern(store, { policies: [{ name: "allow-erase", beforeErase: () => true }], context: () => ({ actor: "bench" }), audit: storeAudit(store) });
  const t = { store, governed };
  // Block 0 warms up: the first audited write walks the (empty) chain once.
  await governed.updateNode(blocks[0].facts[9], { confidenceWeight: 0.2 });
  const perOp = Math.min(reps, Math.floor((blocks.length - 1) / OPERATIONS.length));
  let next = 1;
  const ops = {};
  for (const op of OPERATIONS) {
    const ms = [];
    let rows = 0;
    for (let r = 0; r < perOp; r++) {
      const block = next++;
      const before = tally.rows;
      const start = performance.now();
      await op.run(t, blocks[block], block);
      ms.push(performance.now() - start);
      rows += tally.rows - before;
    }
    ops[op.name] = { median_ms: round4(median(ms)), p90_ms: round4(p90(ms)), rows_per_call: round4(rows / perOp), reps: perOp };
  }
  await db.close();
  results.push({ facts: size, seed_s: round4(seedS), operations: ops });
  console.log(`${size} facts (seeded in ${seedS.toFixed(1)} s)`);
  for (const [name, o] of Object.entries(ops)) console.log(`  ${name.padEnd(22)} median ${o.median_ms.toFixed(2).padStart(7)} ms  p90 ${o.p90_ms.toFixed(2).padStart(7)} ms  rows/call ${o.rows_per_call}`);
}

const smallest = results[0];
const largest = results[results.length - 1];
const ratios = Object.fromEntries(Object.keys(largest.operations).map((name) => [name, round4(largest.operations[name].median_ms / smallest.operations[name].median_ms)]));
const worst = Object.entries(ratios).sort((a, b) => b[1] - a[1])[0];
const sameRows = Object.keys(largest.operations).every((name) => largest.operations[name].rows_per_call === smallest.operations[name].rows_per_call);
const path = resultPath(RESULTS_DIR, isoDate(), "postgres-writes");
writeJson(path, { benchmark: "postgres-writes", run: info, settings: { sizes, reps, backend: "PGlite (in-process) with pgvector", indexedDimensions: 3 }, results, median_ratio_largest_to_smallest: ratios });
console.log(`wrote ${path}`);
console.log(`RESULT: from ${smallest.facts} to ${largest.facts} facts, the write that grew most (${worst[0]}) went from ${smallest.operations[worst[0]].median_ms.toFixed(2)} ms to ${largest.operations[worst[0]].median_ms.toFixed(2)} ms median (${worst[1].toFixed(2)}x), and every write ${sameRows ? "read the same rows at both sizes" : "did NOT read the same rows at both sizes"}.`);
