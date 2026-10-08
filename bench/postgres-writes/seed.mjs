/**
 * A Postgres tenant of `size` facts, written straight into the store's tables
 * so a 20,000-fact tenant takes seconds rather than 20,000 transactions. The
 * rows come from the library's own in-memory engine (passed in, so the cost
 * test can use the source and the benchmark the build), so every fact,
 * version, edge and embedding is one the store itself would have written.
 *
 * Every block of ten facts has the same shape, so block k of a small tenant
 * and block k of a large one cost the same to change:
 *
 *   f0  one recorded version, an embedding, an edge to f1, a conclusion f2 drawn from it
 *   f1  the other end of that edge
 *   f2  concluded from f0 (contextualMetadata.derivedFrom)
 *   f3–f9  plain facts
 */
export const BLOCK = 10;
export const MODEL = "seed-model";

const TOPICS = ["roadmap", "invoice", "meeting", "deadline", "travel", "budget", "hiring", "release", "support", "design"];

export function seedNode(i, overrides = {}) {
  return {
    provenance: "UserInput",
    encryptionKeyRef: "seed-key",
    memoryType: "Experience",
    privacyClassification: "Private",
    retentionTier: "FullRetention",
    content: { text: `fact ${i} about the ${TOPICS[i % TOPICS.length]} ${Math.floor(i / BLOCK)}` },
    contextualMetadata: { tags: [TOPICS[i % TOPICS.length]] },
    confidenceWeight: 1.0,
    decayRate: 0.0,
    ...overrides,
  };
}

/**
 * Write `size` facts (a multiple of {@link BLOCK}) for an initialised store's
 * tenant. Returns each block's ids, `facts[0..9]` and `edgeId` (f0 → f1), and
 * `restore`, fact f5 as an importer would hold it.
 */
export async function seedTenant(db, tenantId, size, InMemoryStore, { dimensions = 3 } = {}) {
  if (size % BLOCK !== 0) throw new Error(`size must be a multiple of ${BLOCK}`);
  const engine = new InMemoryStore();
  const blocks = [];
  for (let b = 0; b < size / BLOCK; b++) {
    const facts = [];
    for (let j = 0; j < BLOCK; j++) {
      const i = b * BLOCK + j;
      const overrides = j === 2 ? { provenance: "AIInferred", contextualMetadata: { derivedFrom: [facts[0]], tags: ["derived"] } } : {};
      facts.push((await engine.addNode(seedNode(i, overrides))).nodeId);
    }
    await engine.updateNode(facts[0], { confidenceWeight: 0.9 });
    const edge = await engine.addEdge({ sourceNodeId: facts[0], targetNodeId: facts[1], relationshipType: "Conceptual", strength: 1, provenance: "UserAsserted" });
    const vector = Array.from({ length: dimensions }, (_, d) => (d === b % dimensions ? 1 : 0));
    await engine.setEmbedding({ nodeId: facts[0], model: MODEL, modelVersion: "1", dimensions, metric: "cosine", vector });
    blocks.push({ facts, edgeId: edge.edgeId });
  }
  // The full fact a restore hands back, as an importer would hold it.
  for (const block of blocks) block.restore = await engine.getNode(block.facts[5]);
  const state = await engine.historySnapshot();
  const embeddings = await engine.listEmbeddings(MODEL);
  // Insertion order is the store's own: a fact before its edges and versions.
  const rows = [
    ...state.nodes.map((n) => ({ id: n.nodeId, kind: "node", metadata: n, content: n.content.text })),
    ...state.edges.map((e) => ({ id: e.edgeId, kind: "edge", metadata: e })),
    ...state.versions.map((v) => ({ id: v.versionId, kind: "version", metadata: v })),
    ...embeddings.map((e) => ({ id: JSON.stringify([e.nodeId, e.model]), kind: "embedding", metadata: e, vector: `[${e.vector.join(",")}]`, model: e.model, dimensions: e.dimensions })),
  ];
  for (let start = 0; start < rows.length; start += 1000) {
    await db.query(
      `INSERT INTO memory_items(tenant_key,id,kind,owner_key,metadata,content,embedding,model,dimensions)
       SELECT $1, r->>'id', r->>'kind', $1, r->'metadata', r->>'content', (r->>'vector')::vector, r->>'model', (r->>'dimensions')::integer
       FROM jsonb_array_elements($2::jsonb) WITH ORDINALITY AS t(r, n) ORDER BY n`,
      [tenantId, JSON.stringify(rows.slice(start, start + 1000))],
    );
  }
  await db.query("ANALYZE memory_items");
  return blocks;
}

/** The median of a list of numbers. */
export function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * A query client that counts what the store asks of the database: queries
 * sent and rows returned, through `transaction` too.
 */
export function countingClient(db) {
  const tally = { queries: 0, rows: 0 };
  const wrap = (q) => ({
    async query(sql, values) {
      const result = await q.query(sql, values);
      tally.queries++;
      tally.rows += result.rows.length;
      return result;
    },
  });
  return { tally, client: { ...wrap(db), transaction: (work) => db.transaction((tx) => work(wrap(tx))) } };
}

/**
 * The writes measured, each against its own block so no two touch the same
 * facts. `store` is a PostgresMemoryStore, `governed` the same store behind
 * `govern(store, { audit: storeAudit(store) })`.
 */
export const OPERATIONS = [
  { name: "addNode", run: ({ store }, _block, i) => store.addNode(seedNode(i)) },
  { name: "updateNode", run: ({ store }, block) => store.updateNode(block.facts[0], { confidenceWeight: 0.5 }) },
  { name: "invalidate", run: ({ store }, block) => store.updateNode(block.facts[0], { validTo: new Date().toISOString() }) },
  { name: "addEdge", run: ({ store }, block) => store.addEdge({ sourceNodeId: block.facts[3], targetNodeId: block.facts[4], relationshipType: "Conceptual", strength: 0.5, provenance: "UserAsserted" }) },
  { name: "deleteEdge", run: ({ store }, block) => store.deleteEdge(block.edgeId) },
  { name: "restoreNode", run: ({ store }, block) => store.restoreNode({ ...block.restore, confidenceWeight: 0.3 }) },
  { name: "deleteNode", run: ({ store }, block) => store.deleteNode(block.facts[0]) },
  { name: "governed updateNode", run: ({ governed }, block) => governed.updateNode(block.facts[6], { confidenceWeight: 0.4 }) },
  { name: "governed invalidate", run: ({ governed }, block) => governed.updateNode(block.facts[0], { validTo: new Date().toISOString() }) },
  { name: "governed deleteNode", run: ({ governed }, block) => governed.deleteNode(block.facts[0]) },
];
