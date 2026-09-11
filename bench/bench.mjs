// Usage: npm run build && node bench/bench.mjs /tmp/bench.db 100000
// Inserts N synthetic facts into a fresh SQLite store and times the paths the README "Limits" table reports.
import { SqliteMemoryStore } from "../dist/index.js";
import { statSync } from "node:fs";
const N = Number(process.argv[3] ?? 100000);
const store = new SqliteMemoryStore(process.argv[2]);
const words = ["lisbon","sourdough","diving","azores","metric","berlin","tokyo","london","piano","chess","garden","marathon","sailing","kubernetes","typescript","espresso","violin","surfing","pottery","astronomy"];
const base = { encryptionKeyRef: "bench", privacyClassification: "Private", retentionTier: "FullRetention", contextualMetadata: {}, decayRate: 0, confidenceWeight: 1 };
let t = performance.now();
for (let i = 0; i < N; i++) {
  const w = words[i % words.length], w2 = words[(i * 7) % words.length];
  await store.addNode({ ...base, provenance: i % 5 === 0 ? "AIInferred" : "UserInput", memoryType: i % 3 === 0 ? "Lesson" : "Experience", content: { text: `Fact ${i}: likes ${w} and ${w2}, mentioned on day ${i % 365}` } });
}
const insertMs = performance.now() - t;
const q = async (label, query, limit) => { const t0 = performance.now(); const r = await store.searchNodes({ query, limit }); const ms = performance.now() - t0; console.log(`${label}: ${r.length} results in ${ms.toFixed(1)} ms`); };
await q("warm-up", "sourdough", 10);
const times = [];
for (const term of ["azores", "kubernetes espresso", "day 42", "violin", "tokyo"]) { const t0 = performance.now(); await store.searchNodes({ query: term, limit: 10 }); times.push(performance.now() - t0); }
const tq = performance.now(); const first = await store.searchNodes({ limit: 10 }); const noQueryMs = performance.now() - tq; const someId = first[0].nodeId;
const t1 = performance.now(); await store.getNode(someId); const getMs = performance.now() - t1;
const t2 = performance.now(); await store.updateNode(someId, { validTo: new Date().toISOString() }); const updMs = performance.now() - t2;
console.log(JSON.stringify({ facts: N, insert_total_s: +(insertMs / 1000).toFixed(1), inserts_per_s: Math.round(N / (insertMs / 1000)), fts_recall_ms_p50: +times.sort((a, b) => a - b)[2].toFixed(1), fts_recall_ms_max: +times[times.length - 1].toFixed(1), no_query_top10_ms: +noQueryMs.toFixed(1), get_by_id_ms: +getMs.toFixed(2), invalidate_ms: +updMs.toFixed(2), db_mb: +(statSync(process.argv[2]).size / 1048576).toFixed(1) }));
