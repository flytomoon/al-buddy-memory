import { AsyncLocalStorage } from "node:async_hooks";
import { Pool } from "pg";
import { InMemoryStore } from "./in-memory-store.js";
import { compareRecency, effectiveConfidence } from "./decay.js";
import { DERIVED_FROM as DERIVED_FROM_KEY, type DependentsCapable } from "./derived.js";
import { canonicalInstant } from "./instant.js";
import { normaliseLimit, queryTokens } from "./query-filter.js";
import { canonical, chainDigest, GENESIS, linkFault, EVENT_LABELS } from "./governance/chain.js";
import type { AuditCapable, AuditEvent, AuditVerifiable, AuditVisitor } from "./governance/audit.js";
import type { AuditTableResult } from "./governance/audit-table.js";
import type { AsOfFact, AsOfOptions, AsOfSnapshot, GraphSnapshot, HistoryCapable, LabelFilter, MemoryEdge, MemoryEmbedding, MemoryNode, MemoryQueryOptions, MemoryStore, NewMemoryNode, NodeVersion, SnapshotCapable } from "./types/memory.js";

/** The small query shape shared by node-postgres and PGlite. Production uses Pool. */
export interface PostgresQueryClient {
  query(sql: string, values?: unknown[]): Promise<{ rows: any[] }>;
  transaction?<T>(callback: (client: PostgresQueryClient) => Promise<T>): Promise<T>;
}

export interface PostgresMemoryStoreOptions {
  /** Every read and write is confined to this key. Use an authenticated, stable tenant identifier. */
  tenantId: string;
  /** Existing pool or PGlite test client. Omit to create a node-postgres pool. */
  client?: PostgresQueryClient;
  connectionString?: string;
  /** Fixed dimension indexed with HNSW. Other model dimensions remain storable and scanable. */
  indexedDimensions?: number;
  auditKey?: string;
}

/**
 * A {@link LabelFilter} as a WHERE condition over a node's `contextualMetadata`,
 * labels and values bound as parameters. The same rule as `matchesLabels`: the
 * label is one of the strings, or an array holding one (`jsonb_exists_any`
 * matches a scalar string or a top-level array element; an object's keys are
 * excluded by the type check).
 */
function labelCondition(filter: LabelFilter, values: unknown[], column: string): string {
  if ("all" in filter) return filter.all.length === 0 ? "TRUE" : `(${filter.all.map(f => labelCondition(f, values, column)).join(" AND ")})`;
  if ("any" in filter) return filter.any.length === 0 ? "FALSE" : `(${filter.any.map(f => labelCondition(f, values, column)).join(" OR ")})`;
  if (filter.in.length === 0) return "FALSE";
  values.push(filter.label);
  const label = `${column}->'contextualMetadata'->$${values.length}::text`;
  values.push([...filter.in]);
  return `(jsonb_typeof(${label}) IN ('string','array') AND jsonb_exists_any(${label}, $${values.length}::text[]))`;
}

type Item = { id: string; kind: string; metadata: unknown };
const json = (v: unknown): string => JSON.stringify(v);
const object = <T>(v: unknown): T => (typeof v === "string" ? JSON.parse(v) : v) as T;
/** Ids as the caller passed them, minus anything that is not a string: the engine rejects those with its own message. */
const ids = (values: readonly unknown[] = []): string[] => [...new Set(values.filter((v): v is string => typeof v === "string"))];
const DERIVED_FROM = `metadata->'contextualMetadata'->'${DERIVED_FROM_KEY}'`;

/**
 * The rows one call reads instead of the tenant's whole graph. The engine
 * applies the same rules to this part of the graph that it would to all of
 * it, because every rule it runs looks only at these rows: a fact's own
 * versions (its next anchor and history), the facts resting on it (an
 * invalidation retracts them, an erasure takes them), an edge's endpoints.
 */
interface Scope {
  /** Facts the call acts on, loaded with their versions. */
  nodes?: readonly unknown[];
  /** Versions by id; the fact each one belongs to joins `nodes`. */
  versions?: readonly unknown[];
  /** Also every fact resting on `nodes`, directly or through another conclusion (derived.ts). */
  dependents?: boolean;
  /** Edges by id, loaded with both endpoints. */
  edges?: readonly unknown[];
  /** Also every edge touching a fact in `nodes`, with its other endpoint. */
  edgesOf?: boolean;
}

/**
 * Shared Postgres storage for hosted tenants. The domain rules come from the
 * same engine as InMemoryStore, run over only the rows a call acts on: each
 * write locks one tenant, reads its scope (see {@link Scope}) and persists the
 * rows that changed, so its cost does not grow with the tenant. Invalidation
 * is an UPDATE, never a physical delete. Explicit `deleteNode` is the governed
 * erasure operation and removes dependent rows.
 */
export class PostgresMemoryStore implements MemoryStore, SnapshotCapable, HistoryCapable, AuditCapable, AuditVerifiable, DependentsCapable {
  private readonly pool: Pool | undefined;
  private readonly client: PostgresQueryClient;
  private readonly context = new AsyncLocalStorage<PostgresQueryClient>();
  readonly tenantId: string;
  private readonly auditKey: string | undefined;
  private readonly dimensions: number;
  /** Whether this object has walked the tenant's audit chain (see `checkChainOnce`). */
  private chainChecked = false;

  constructor(options: PostgresMemoryStoreOptions) {
    if (!options.tenantId) throw new Error("tenantId is required");
    if (!options.client && !options.connectionString) throw new Error("connectionString or client is required");
    this.tenantId = options.tenantId;
    this.auditKey = options.auditKey;
    this.dimensions = options.indexedDimensions ?? 1536;
    if (!Number.isInteger(this.dimensions) || this.dimensions < 1 || this.dimensions > 2000) throw new Error("indexedDimensions must be an integer from 1 to 2000");
    this.pool = options.client ? undefined : new Pool({ connectionString: options.connectionString });
    this.client = options.client ?? this.pool!;
  }

  async initialize(): Promise<void> {
    await this.client.query("CREATE EXTENSION IF NOT EXISTS vector");
    const version = (await this.client.query("SELECT extversion FROM pg_extension WHERE extname='vector'")).rows[0]?.extversion as string | undefined;
    const [major, minor] = (version ?? "").split(".").map(Number);
    if (major === undefined || minor === undefined || !Number.isInteger(major) || !Number.isInteger(minor) || major < 0 || (major === 0 && minor < 8)) {
      throw new Error(`pgvector 0.8 or newer is required; found ${version ?? "none"}`);
    }
    await this.client.query(`CREATE TABLE IF NOT EXISTS memory_tenants (
      tenant_key text PRIMARY KEY,
      audit_count bigint NOT NULL DEFAULT 0,
      audit_head text NOT NULL DEFAULT '${GENESIS}'
    )`);
    await this.client.query(`CREATE TABLE IF NOT EXISTS memory_items (
      tenant_key text NOT NULL REFERENCES memory_tenants(tenant_key),
      id text NOT NULL,
      kind text NOT NULL CHECK (kind IN ('node','edge','version','embedding')),
      owner_key text NOT NULL,
      metadata jsonb NOT NULL,
      content text,
      search_terms tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce(content, ''))) STORED,
      embedding vector,
      model text,
      dimensions integer,
      row_order bigint GENERATED ALWAYS AS IDENTITY,
      PRIMARY KEY (tenant_key, kind, id)
    )`);
    await this.client.query("CREATE INDEX IF NOT EXISTS memory_items_search_idx ON memory_items USING gin(search_terms) WHERE kind = 'node'");
    await this.client.query("CREATE INDEX IF NOT EXISTS memory_items_owner_idx ON memory_items(tenant_key, owner_key, kind)");
    // What a write looks up besides its own rows (loadScope): a fact's versions
    // and embeddings, the edges at either end of a fact, the facts resting on one.
    await this.client.query("CREATE INDEX IF NOT EXISTS memory_items_node_ref_idx ON memory_items(tenant_key, kind, (metadata->>'nodeId'))");
    await this.client.query("CREATE INDEX IF NOT EXISTS memory_items_edge_source_idx ON memory_items(tenant_key, kind, (metadata->>'sourceNodeId'))");
    await this.client.query("CREATE INDEX IF NOT EXISTS memory_items_edge_target_idx ON memory_items(tenant_key, kind, (metadata->>'targetNodeId'))");
    // Only conclusions are indexed, and without GIN's pending list: a lookup
    // would otherwise scan every fact inserted since the last vacuum.
    await this.client.query(`CREATE INDEX IF NOT EXISTS memory_items_derived_idx ON memory_items USING gin((${DERIVED_FROM})) WITH (fastupdate = off) WHERE kind = 'node' AND jsonb_typeof(${DERIVED_FROM}) = 'array'`);
    // pgvector supports mixed dimensions in one column; index only the selected dimension.
    await this.client.query(`CREATE INDEX IF NOT EXISTS memory_items_hnsw_${this.dimensions} ON memory_items USING hnsw ((embedding::vector(${this.dimensions})) vector_cosine_ops) WHERE kind = 'embedding' AND dimensions = ${this.dimensions}`);
    await this.client.query(`CREATE TABLE IF NOT EXISTS memory_audit_events (
      tenant_key text NOT NULL REFERENCES memory_tenants(tenant_key),
      seq bigint GENERATED ALWAYS AS IDENTITY,
      prev text NOT NULL, hash text NOT NULL, event jsonb NOT NULL,
      PRIMARY KEY (tenant_key, seq)
    )`);
    await this.client.query("INSERT INTO memory_tenants(tenant_key) VALUES($1) ON CONFLICT DO NOTHING", [this.tenantId]);
  }

  async close(): Promise<void> { await this.pool?.end(); }

  private async transaction<T>(work: (db: PostgresQueryClient) => Promise<T>, lock = false): Promise<T> {
    const active = this.context.getStore();
    if (active) return work(active);
    const run = async (db: PostgresQueryClient): Promise<T> => this.context.run(db, async () => {
      await db.query("INSERT INTO memory_tenants(tenant_key) VALUES($1) ON CONFLICT DO NOTHING", [this.tenantId]);
      if (lock) await db.query("SELECT tenant_key FROM memory_tenants WHERE tenant_key = $1 FOR UPDATE", [this.tenantId]);
      await db.query("SET LOCAL hnsw.iterative_scan = strict_order");
      return work(db);
    });
    if (this.client.transaction) return this.client.transaction(run);
    const connection = await this.pool!.connect();
    try {
      await connection.query("BEGIN");
      const result = await run(connection);
      await connection.query("COMMIT");
      return result;
    } catch (error) {
      await connection.query("ROLLBACK");
      throw error;
    } finally { connection.release(); }
  }

  /** One snapshot that writes nothing — not even the tenant row `transaction` ensures. */
  private async readOnly<T>(work: (db: PostgresQueryClient) => Promise<T>): Promise<T> {
    const run = async (db: PostgresQueryClient): Promise<T> => {
      await db.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      return work(db);
    };
    if (this.client.transaction) return this.client.transaction(run);
    const connection = await this.pool!.connect();
    try {
      await connection.query("BEGIN");
      const result = await run(connection);
      await connection.query("COMMIT");
      return result;
    } catch (error) {
      await connection.query("ROLLBACK");
      throw error;
    } finally { connection.release(); }
  }

  /** The whole graph, for the calls that answer about all of it (snapshots). */
  private async load(db: PostgresQueryClient): Promise<{ engine: InMemoryStore; rows: Item[] }> {
    return this.hydrate((await db.query("SELECT id, kind, metadata FROM memory_items WHERE tenant_key = $1 AND kind <> 'embedding' ORDER BY row_order", [this.tenantId])).rows as Item[]);
  }

  /**
   * One call's part of the graph ({@link Scope}). Every lookup is by key or by
   * an index in `initialize`, so what it costs depends on the facts touched,
   * not on how many the tenant holds.
   */
  private async loadScope(db: PostgresQueryClient, scope: Scope): Promise<{ engine: InMemoryStore; rows: Item[] }> {
    const tenant = this.tenantId;
    const acted = new Set(ids(scope.nodes));
    const versionIds = ids(scope.versions);
    if (versionIds.length) {
      for (const r of (await db.query("SELECT metadata->>'nodeId' AS node FROM memory_items WHERE tenant_key=$1 AND kind='version' AND id = ANY($2::text[])", [tenant, versionIds])).rows) acted.add(r.node);
    }
    if (scope.dependents) {
      for (let frontier = [...acted]; frontier.length;) {
        const found = (await db.query(`SELECT id FROM memory_items WHERE tenant_key=$1 AND kind='node' AND jsonb_typeof(${DERIVED_FROM})='array' AND ${DERIVED_FROM} ?| $2::text[]`, [tenant, frontier])).rows.map(r => r.id as string);
        frontier = found.filter(id => !acted.has(id));
        for (const id of frontier) acted.add(id);
      }
    }
    const edgeIds = ids(scope.edges);
    const around = scope.edgesOf ? [...acted] : [];
    const edges = edgeIds.length || around.length
      ? (await db.query(`SELECT id, kind, metadata FROM memory_items WHERE tenant_key=$1 AND kind='edge'
          AND (id = ANY($2::text[]) OR metadata->>'sourceNodeId' = ANY($3::text[]) OR metadata->>'targetNodeId' = ANY($3::text[])) ORDER BY row_order`, [tenant, edgeIds, around])).rows as Item[]
      : [];
    const wanted = new Set(acted);
    for (const e of edges) for (const end of [object<MemoryEdge>(e.metadata).sourceNodeId, object<MemoryEdge>(e.metadata).targetNodeId]) wanted.add(end);
    const nodes = wanted.size ? (await db.query("SELECT id, kind, metadata FROM memory_items WHERE tenant_key=$1 AND kind='node' AND id = ANY($2::text[]) ORDER BY row_order", [tenant, [...wanted]])).rows as Item[] : [];
    // Versions only of the facts acted on: an edge's other endpoint is read, never changed.
    const versions = acted.size ? (await db.query("SELECT id, kind, metadata FROM memory_items WHERE tenant_key=$1 AND kind='version' AND metadata->>'nodeId' = ANY($2::text[]) ORDER BY row_order", [tenant, [...acted]])).rows as Item[] : [];
    return this.hydrate([...nodes, ...edges, ...versions]);
  }

  /** `rows` (in row order) into an engine, which applies the domain rules to them. */
  private async hydrate(rows: Item[]): Promise<{ engine: InMemoryStore; rows: Item[] }> {
    const engine = new InMemoryStore();
    for (const row of rows.filter(r => r.kind === "node")) await engine.restoreNode(object<MemoryNode>(row.metadata));
    for (const row of rows.filter(r => r.kind === "edge")) await engine.restoreEdge(object<MemoryEdge>(row.metadata));
    for (const row of rows.filter(r => r.kind === "version")) engine.loadStoredVersion(object<NodeVersion>(row.metadata));
    return { engine, rows };
  }

  private async persist(db: PostgresQueryClient, old: Item[], engine: InMemoryStore): Promise<void> {
    const state = await engine.historySnapshot();
    const current: Item[] = [
      ...state.nodes.map(n => ({ id: n.nodeId, kind: "node", metadata: n })),
      ...state.edges.map(e => ({ id: e.edgeId, kind: "edge", metadata: e })),
      ...state.versions.map(v => ({ id: v.versionId, kind: "version", metadata: v })),
    ];
    const key = (r: Item) => `${r.kind}\u0000${r.id}`;
    const before = new Map(old.map(r => [key(r), r]));
    const after = new Set(current.map(key));
    for (const row of old) if (!after.has(key(row))) {
      await db.query("DELETE FROM memory_items WHERE tenant_key=$1 AND kind=$2 AND id=$3", [this.tenantId, row.kind, row.id]);
      if (row.kind === "node") await db.query("DELETE FROM memory_items WHERE tenant_key=$1 AND kind='embedding' AND metadata->>'nodeId'=$2", [this.tenantId, row.id]);
    }
    for (const row of current) {
      if (before.has(key(row)) && canonical(object(before.get(key(row))!.metadata)) === canonical(row.metadata)) continue;
      const node = row.kind === "node" ? row.metadata as MemoryNode : undefined;
      await db.query(`INSERT INTO memory_items(tenant_key,id,kind,owner_key,metadata,content)
        VALUES($1,$2,$3,$4,$5::jsonb,$6)
        ON CONFLICT (tenant_key,kind,id) DO UPDATE SET metadata=excluded.metadata, content=excluded.content`,
      [this.tenantId, row.id, row.kind, this.tenantId, json(row.metadata), node?.content.text ?? null]);
    }
  }

  /** `scope` is the call's part of the graph, or "all" for the calls that answer about all of it. */
  private async read<T>(scope: Scope | "all", work: (engine: InMemoryStore) => Promise<T>): Promise<T> {
    return this.transaction(async db => work((scope === "all" ? await this.load(db) : await this.loadScope(db, scope)).engine));
  }
  private async write<T>(scope: Scope, work: (engine: InMemoryStore) => Promise<T>): Promise<T> {
    return this.transaction(async db => {
      const { engine, rows } = await this.loadScope(db, scope);
      const result = await work(engine);
      await this.persist(db, rows, engine);
      return result;
    }, true);
  }

  addNode(node: NewMemoryNode): Promise<MemoryNode> { return this.write({}, s => s.addNode(node)); }
  getNode(id: string): Promise<MemoryNode | undefined> { return this.read({ nodes: [id] }, s => s.getNode(id)); }
  /** Facts only, newest first as the engine orders them: no edges or versions are read. */
  async listNodes(): Promise<MemoryNode[]> {
    return this.transaction(async db => (await db.query("SELECT metadata FROM memory_items WHERE tenant_key=$1 AND kind='node' ORDER BY row_order", [this.tenantId])).rows
      .map(r => object<MemoryNode>(r.metadata)).sort((a, b) => compareRecency(b, a)));
  }
  updateNode(id: string, patch: Parameters<MemoryStore["updateNode"]>[1], event?: Parameters<MemoryStore["updateNode"]>[2]): Promise<MemoryNode> {
    // Only a change that sets an end can retract the facts resting on this one.
    const ends = typeof patch === "object" && patch !== null && (patch as { validTo?: unknown }).validTo != null;
    return this.write({ nodes: [id], dependents: ends }, s => s.updateNode(id, patch, event));
  }
  deleteNode(id: string): Promise<void> { return this.write({ nodes: [id], dependents: true, edgesOf: true }, s => s.deleteNode(id)); }
  restoreNode(node: MemoryNode): Promise<void> { return this.write({ nodes: [node?.nodeId] }, s => s.restoreNode(node)); }
  restoreEdge(edge: MemoryEdge): Promise<void> { return this.write({ nodes: [edge?.sourceNodeId, edge?.targetNodeId], edges: [edge?.edgeId] }, s => s.restoreEdge(edge)); }
  addEdge(edge: Parameters<MemoryStore["addEdge"]>[0]): Promise<MemoryEdge> { return this.write({ nodes: [edge?.sourceNodeId, edge?.targetNodeId] }, s => s.addEdge(edge)); }
  getEdges(id: string): Promise<MemoryEdge[]> { return this.read({ nodes: [id], edgesOf: true }, s => s.getEdges(id)); }
  deleteEdge(id: string): Promise<void> { return this.write({ edges: [id] }, s => s.deleteEdge(id)); }
  snapshot(): Promise<GraphSnapshot> { return this.read("all", s => s.snapshot()); }
  history(id: string): Promise<NodeVersion[]> { return this.read({ nodes: [id] }, s => s.history(id)); }
  getNodeAsOf(id: string, at: string): Promise<AsOfFact | undefined> { return this.read({ nodes: [id] }, s => s.getNodeAsOf(id, at)); }
  snapshotAsOf(at: string, options?: AsOfOptions): Promise<AsOfSnapshot> { return this.read("all", s => s.snapshotAsOf(at, options)); }
  historySnapshot(): Promise<GraphSnapshot & { versions: NodeVersion[] }> { return this.read("all", s => s.historySnapshot()); }
  restoreVersion(version: NodeVersion): Promise<void> { return this.write({ nodes: [version?.nodeId], versions: [version?.versionId] }, s => s.restoreVersion(version)); }

  /**
   * Every fact resting on `roots`, directly or through another conclusion, in
   * `listNodes` order — what the governed cascade judges before an erasure or
   * an invalidation, read by index rather than by listing the tenant.
   */
  async nodesRestingOn(roots: readonly string[]): Promise<MemoryNode[]> {
    const rootIds = new Set(roots);
    // The scope holds the roots and what rests on them, nothing else.
    return this.read({ nodes: roots, dependents: true }, async s => (await s.listNodes()).filter(n => !rootIds.has(n.nodeId)));
  }

  async searchNodes(options: MemoryQueryOptions): Promise<MemoryNode[]> {
    return this.transaction(async db => {
      const values: unknown[] = [this.tenantId];
      let where = "tenant_key=$1 AND kind='node'";
      const add = (fragment: string, value: unknown) => { values.push(value); where += ` AND ${fragment.replaceAll("?", `$${values.length}`)}`; };
      if (options.memoryType !== undefined) add("metadata->>'memoryType' = ANY(?::text[])", Array.isArray(options.memoryType) ? options.memoryType : [options.memoryType]);
      if (options.privacyClassification?.length) add("metadata->>'privacyClassification' = ANY(?::text[])", options.privacyClassification);
      else where += " AND metadata->>'privacyClassification' <> 'Sealed'";
      if (options.retentionTier?.length) add("metadata->>'retentionTier' = ANY(?::text[])", options.retentionTier);
      else where += " AND metadata->>'retentionTier' NOT IN ('Archived','PendingDeletion')";
      if (options.tags?.length) add("(jsonb_typeof(metadata->'contextualMetadata'->'tags') = 'array' AND jsonb_exists_any(metadata->'contextualMetadata'->'tags', ?::text[]))", options.tags);
      if (options.minConfidence !== undefined) add("(metadata->>'confidenceWeight')::double precision >= ?", options.minConfidence);
      if (options.labels !== undefined) where += ` AND ${labelCondition(options.labels, values, "metadata")}`;
      if (options.validAt !== undefined) {
        const at = canonicalInstant(options.validAt, "validAt");
        add("(metadata->>'validFrom')::timestamptz <= ?::timestamptz", at);
        add("((metadata->>'validTo') IS NULL OR (metadata->>'validTo')::timestamptz > ?::timestamptz)", at);
      }
      let rank = "0::real";
      if (options.query !== undefined) {
        const tokens = queryTokens(options.query);
        if (!tokens.length) return [];
        // OR terms match SQLite FTS behavior; every term is quoted as a tsquery lexeme.
        const tsquery = tokens.map(t => `'${t.toLowerCase().replaceAll("'", "''")}'`).join(" | ");
        add("search_terms @@ ?::tsquery", tsquery);
        rank = `ts_rank_cd(search_terms, $${values.length}::tsquery)`;
      }
      // SQL computes relevance on only the rows admitted by all visibility filters.
      const rows = (await db.query(`SELECT metadata, ${rank} AS rank FROM memory_items WHERE ${where}`, values)).rows;
      const now = Date.now();
      const sorted = rows.map(r => ({ node: object<MemoryNode>(r.metadata), rank: Number(r.rank) }))
        .sort((a, b) => b.rank - a.rank || effectiveConfidence(b.node, now) - effectiveConfidence(a.node, now) || compareRecency(a.node, b.node));
      const after = options.after === undefined ? 0 : sorted.findIndex(r => r.node.nodeId === options.after) + 1;
      if (options.after !== undefined && after === 0) return [];
      const limit = normaliseLimit(options.limit);
      return sorted.slice(after, limit === undefined ? undefined : after + limit).map(r => r.node);
    });
  }

  async setEmbedding(input: Omit<MemoryEmbedding, "createdAt">): Promise<MemoryEmbedding> {
    return this.transaction(async db => {
      if (!(await this.getNode(input.nodeId))) throw new Error(`embedding node not found: ${input.nodeId}`);
      if (input.vector.length !== input.dimensions || input.vector.some(n => !Number.isFinite(n))) throw new Error("invalid embedding vector");
      const full: MemoryEmbedding = { ...structuredClone(input), createdAt: new Date().toISOString() };
      await db.query(`INSERT INTO memory_items(tenant_key,id,kind,owner_key,metadata,embedding,model,dimensions)
        VALUES($1,$2,'embedding',$1,$3::jsonb,$4::vector,$5,$6)
        ON CONFLICT (tenant_key,kind,id) DO UPDATE SET metadata=excluded.metadata,embedding=excluded.embedding,dimensions=excluded.dimensions`,
      [this.tenantId, json([input.nodeId, input.model]), json(full), `[${input.vector.join(",")}]`, input.model, input.dimensions]);
      return full;
    }, true);
  }
  private async embeddingRows(where: string, value: string): Promise<MemoryEmbedding[]> {
    return this.transaction(async db => (await db.query(`SELECT metadata FROM memory_items WHERE tenant_key=$1 AND kind='embedding' AND ${where}`, [this.tenantId, value])).rows.map(r => object<MemoryEmbedding>(r.metadata)));
  }
  getEmbeddings(id: string): Promise<MemoryEmbedding[]> { return this.embeddingRows("metadata->>'nodeId'=$2", id); }
  listEmbeddings(model: string): Promise<MemoryEmbedding[]> { return this.embeddingRows("model=$2", model); }
  async deleteEmbeddings(id: string, model?: string): Promise<void> {
    await this.transaction(async db => { await db.query(`DELETE FROM memory_items WHERE tenant_key=$1 AND kind='embedding' AND metadata->>'nodeId'=$2 ${model === undefined ? "" : "AND model=$3"}`, model === undefined ? [this.tenantId, id] : [this.tenantId, id, model]); }, true);
  }

  /** Indexed cosine search with filters applied before LIMIT. The existing MemoryStore API is unchanged. */
  async searchSimilar(model: string, modelVersion: string, vector: number[], options: Omit<MemoryQueryOptions, "query" | "after"> = {}): Promise<{ node: MemoryNode; similarity: number }[]> {
    if (vector.length !== this.dimensions || vector.some(n => !Number.isFinite(n))) throw new Error(`searchSimilar requires a finite ${this.dimensions}-dimension vector`);
    const limit = normaliseLimit(options.limit);
    if (limit === 0) return [];
    return this.transaction(async db => {
      const values: unknown[] = [this.tenantId, model, modelVersion, `[${vector.join(",")}]`];
      let where = `e.tenant_key=$1 AND e.kind='embedding' AND e.model=$2 AND e.metadata->>'modelVersion'=$3 AND e.metadata->>'metric'='cosine' AND e.dimensions=${this.dimensions} AND n.tenant_key=$1 AND n.kind='node'`;
      const add = (fragment: string, value: unknown) => { values.push(value); where += ` AND ${fragment.replace("?", `$${values.length}`)}`; };
      if (options.memoryType !== undefined) add("n.metadata->>'memoryType' = ANY(?::text[])", Array.isArray(options.memoryType) ? options.memoryType : [options.memoryType]);
      if (options.privacyClassification?.length) add("n.metadata->>'privacyClassification' = ANY(?::text[])", options.privacyClassification);
      else where += " AND n.metadata->>'privacyClassification' <> 'Sealed'";
      if (options.retentionTier?.length) add("n.metadata->>'retentionTier' = ANY(?::text[])", options.retentionTier);
      else where += " AND n.metadata->>'retentionTier' NOT IN ('Archived','PendingDeletion')";
      if (options.tags?.length) add("(jsonb_typeof(n.metadata->'contextualMetadata'->'tags') = 'array' AND jsonb_exists_any(n.metadata->'contextualMetadata'->'tags', ?::text[]))", options.tags);
      if (options.minConfidence !== undefined) add("(n.metadata->>'confidenceWeight')::double precision >= ?", options.minConfidence);
      if (options.labels !== undefined) where += ` AND ${labelCondition(options.labels, values, "n.metadata")}`;
      if (options.validAt !== undefined) {
        const at = canonicalInstant(options.validAt, "validAt");
        add("(n.metadata->>'validFrom')::timestamptz <= ?::timestamptz", at);
        add("((n.metadata->>'validTo') IS NULL OR (n.metadata->>'validTo')::timestamptz > ?::timestamptz)", at);
      }
      const distance = `e.embedding::vector(${this.dimensions}) <=> $4::vector(${this.dimensions})`;
      if (limit !== undefined) values.push(limit);
      const rows = (await db.query(`SELECT n.metadata, ${distance} AS distance FROM memory_items e JOIN memory_items n
        ON n.tenant_key=e.tenant_key AND n.id=e.metadata->>'nodeId'
        WHERE ${where} ORDER BY ${distance}${limit === undefined ? "" : ` LIMIT $${values.length}`}`, values)).rows;
      return rows.map(r => ({ node: object<MemoryNode>(r.metadata), similarity: 1 - Number(r.distance) }));
    });
  }

  async auditedMutation<T>(mutate: () => Promise<T>, describe: (result: T) => AuditEvent): Promise<T> {
    await this.checkChainOnce();
    return this.transaction(async db => { const result = await mutate(); await this.appendAudit(db, describe(result)); return result; }, true);
  }
  async recordAuditEvent(event: AuditEvent): Promise<void> {
    await this.checkChainOnce();
    await this.transaction(db => this.appendAudit(db, event), true);
  }

  /**
   * The full walk of the tenant's chain, once per store object and before the
   * tenant lock is taken, as SQLite's `AuditEventTable.ensureChecked` does: a
   * walk on every append made each write cost O(events). If it fails here,
   * `appendAudit` walks again under the lock and refuses with the reason.
   */
  private async checkChainOnce(): Promise<void> {
    if (this.chainChecked || this.context.getStore()) return;
    if ((await this.verifyAudit()).ok) this.chainChecked = true;
  }

  private async appendAudit(db: PostgresQueryClient, event: AuditEvent): Promise<void> {
    if (!this.chainChecked) {
      const walked = await this.walkChain(db);
      if (walked !== undefined && !walked.ok) throw new Error(`audit chain broken: ${walked.reason}`);
      this.chainChecked = true;
    }
    // Every append: the newest event must be the one the tenant row recorded,
    // which catches a trail deleted or cut from the end since the walk.
    const tenant = (await db.query("SELECT audit_count,audit_head FROM memory_tenants WHERE tenant_key=$1", [this.tenantId])).rows[0];
    const last = (await db.query("SELECT hash FROM memory_audit_events WHERE tenant_key=$1 ORDER BY seq DESC LIMIT 1", [this.tenantId])).rows[0];
    const prev: string = last?.hash ?? GENESIS;
    if (tenant.audit_head !== prev || (last === undefined) !== (Number(tenant.audit_count) === 0)) throw new Error("audit chain broken: rows do not match the tenant's recorded head or count");
    const hash = chainDigest(prev, event, this.auditKey);
    await db.query("INSERT INTO memory_audit_events(tenant_key,prev,hash,event) VALUES($1,$2,$3,$4::jsonb)", [this.tenantId, prev, hash, json(event)]);
    await db.query("UPDATE memory_tenants SET audit_count=audit_count+1,audit_head=$2 WHERE tenant_key=$1", [this.tenantId, hash]);
  }
  async auditHead(): Promise<string> {
    return this.transaction(async db => (await db.query("SELECT audit_head FROM memory_tenants WHERE tenant_key=$1", [this.tenantId])).rows[0]?.audit_head ?? GENESIS);
  }

  /**
   * Check this tenant's chain with the store's key, in one read-only snapshot:
   * every link, then the tenant row's count and head, which catch events cut
   * from the end. `head` is a value anchored outside the database. A tenant
   * with no row is reported, never created: a verifier must not call a
   * mistyped tenant "intact: 0 events".
   */
  async verifyAudit(opts: { head?: string; visit?: AuditVisitor } = {}): Promise<AuditTableResult> {
    return this.readOnly(async db => {
      const walked = await this.walkChain(db, opts.visit);
      if (walked === undefined) return { ok: false, count: 0, line: 0, reason: `no tenant ${JSON.stringify(this.tenantId)} in this database` };
      if (walked.ok && opts.head !== undefined && walked.head !== opts.head) {
        return { ok: false, count: walked.count, line: walked.count, reason: "the newest event does not match the anchored head: the trail was cut short or has diverged" };
      }
      return walked;
    });
  }

  /** Every link from genesis, then the tenant row's count and head; undefined when the tenant has no row. */
  private async walkChain(db: PostgresQueryClient, visit?: AuditVisitor): Promise<AuditTableResult | undefined> {
    const tenant = (await db.query("SELECT audit_count,audit_head FROM memory_tenants WHERE tenant_key=$1", [this.tenantId])).rows[0];
    if (tenant === undefined) return undefined;
    const rows = (await db.query("SELECT seq,prev,hash,event FROM memory_audit_events WHERE tenant_key=$1 ORDER BY seq", [this.tenantId])).rows;
    let prev = GENESIS;
    for (const [i, row] of rows.entries()) {
      const event = object<AuditEvent>(row.event);
      const fault = linkFault({ prev: row.prev, hash: row.hash, event }, prev, this.auditKey, i + 1, EVENT_LABELS);
      if (fault) return { ok: false, count: rows.length, line: i + 1, reason: `${fault} (seq ${row.seq})` };
      visit?.(event, i + 1);
      prev = row.hash;
    }
    const recorded = Number(tenant.audit_count);
    if (recorded !== rows.length || tenant.audit_head !== prev) {
      return { ok: false, count: rows.length, line: rows.length, reason: `the tenant row records ${recorded} event(s) and its own head, and the table does not end there: events were removed from the end, or the chain was rewritten` };
    }
    return { ok: true, count: rows.length, head: prev };
  }
}
