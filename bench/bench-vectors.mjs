// Usage: npm run build && node bench/bench-vectors.mjs /tmp/vec.db 20000
//
// Times and sizes the SEMANTIC path, which bench.mjs does not touch: how much a
// vector cache costs on disk, and what a recall costs when the retriever has to
// scan it. Vectors here are synthetic unit vectors of the default embedder's
// width (384, all-MiniLM-L6-v2) rather than real model output, because what is
// being measured is storage and scan cost, not embedding quality or the
// embedder's own runtime — the model download and per-text embed time are a
// separate cost and are called out separately in the README.
import { SqliteMemoryStore, HybridRetriever, FakeEmbedder } from "../dist/index.js";
import { statSync, rmSync } from "node:fs";

const path = process.argv[2] ?? "/tmp/vec.db";
const N = Number(process.argv[3] ?? 20000);
const DIMS = 384;
const MODEL = "xenova/all-MiniLM-L6-v2";

for (const suffix of ["", "-wal", "-shm"]) { try { rmSync(path + suffix); } catch { /* fresh file */ } }

// Deterministic pseudo-random unit vector, so a rerun measures the same thing.
function vectorFor(seed) {
  let s = 0;
  for (let i = 0; i < seed.length; i++) s = (s * 31 + seed.charCodeAt(i)) >>> 0;
  const v = new Array(DIMS);
  let norm = 0;
  for (let i = 0; i < DIMS; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    const x = s / 4294967296 - 0.5;
    v[i] = x;
    norm += x * x;
  }
  norm = Math.sqrt(norm);
  for (let i = 0; i < DIMS; i++) v[i] = v[i] / norm;
  // A real on-device model returns float32 values; model that, so the store's
  // float32 storage (0.8.1) is measured as it is used.
  return Array.from(new Float32Array(v));
}

const words = ["lisbon","sourdough","diving","azores","metric","berlin","tokyo","london","piano","chess","garden","marathon","sailing","kubernetes","typescript","espresso","violin","surfing","pottery","astronomy"];
const base = { encryptionKeyRef: "bench", privacyClassification: "Private", retentionTier: "FullRetention", contextualMetadata: {}, decayRate: 0, confidenceWeight: 1 };

const writer = new SqliteMemoryStore(path);
let t = performance.now();
const ids = [];
for (let i = 0; i < N; i++) {
  const w = words[i % words.length], w2 = words[(i * 7) % words.length];
  const n = await writer.addNode({ ...base, provenance: i % 5 === 0 ? "AIInferred" : "UserInput", memoryType: i % 3 === 0 ? "Lesson" : "Experience", content: { text: `Fact ${i}: likes ${w} and ${w2}, mentioned on day ${i % 365}` } });
  ids.push(n.nodeId);
}
const insertMs = performance.now() - t;
const factsOnlyMb = statSync(path).size / 1048576;

t = performance.now();
for (let i = 0; i < N; i++) {
  await writer.setEmbedding({ nodeId: ids[i], model: MODEL, modelVersion: "1", dimensions: DIMS, metric: "cosine", vector: vectorFor(ids[i]) });
}
const embedStoreMs = performance.now() - t;
const withVectorsMb = statSync(path).size / 1048576;

// What one vector actually costs on disk (float32 bytes since 0.8.1; JSON text before).
const db = writer.db ?? null;
let vectorBytes = null, rowCount = null;
if (db) {
  const r = db.prepare("SELECT COUNT(*) AS n, SUM(LENGTH(vector)) AS b FROM memory_embeddings").get();
  rowCount = r.n; vectorBytes = r.b;
}

// Cold: a newly opened store, so the retriever's 60 s vector cache is empty and
// listEmbeddings has to read and decode every row. The file itself is in the
// OS page cache — this is "first query of a session", not a cold disk.
const embedder = new FakeEmbedder(MODEL, DIMS, (text) => vectorFor(text));
const reader = new SqliteMemoryStore(path);
const retriever = new HybridRetriever(reader, embedder);
t = performance.now();
const cold = await retriever.recall("likes espresso and piano", { limit: 10 });
const coldMs = performance.now() - t;

const warm = [];
for (const q of ["likes tokyo and chess", "likes sailing and violin", "likes berlin and pottery", "likes azores and metric", "likes london and garden"]) {
  const t0 = performance.now();
  await retriever.recall(q, { limit: 10 });
  warm.push(performance.now() - t0);
}
warm.sort((a, b) => a - b);

console.log(JSON.stringify({
  facts: N,
  dimensions: DIMS,
  insert_facts_s: +(insertMs / 1000).toFixed(1),
  store_vectors_s: +(embedStoreMs / 1000).toFixed(1),
  db_mb_facts_only: +factsOnlyMb.toFixed(1),
  db_mb_with_vectors: +withVectorsMb.toFixed(1),
  vector_rows: rowCount,
  vector_text_bytes_total: vectorBytes,
  vector_text_bytes_each: vectorBytes ? Math.round(vectorBytes / rowCount) : null,
  semantic_recall_cold_ms: +coldMs.toFixed(1),
  semantic_recall_warm_ms_p50: +warm[2].toFixed(1),
  semantic_recall_warm_ms_max: +warm[warm.length - 1].toFixed(1),
  cold_results: cold.length,
}, null, 2));
