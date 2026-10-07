import { AsyncLocalStorage } from "node:async_hooks";
import { Pool } from "pg";
import { InMemoryStore } from "./in-memory-store.js";
import { compareRecency, effectiveConfidence } from "./decay.js";
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

/**
 * Shared Postgres storage for hosted tenants. The domain rules come from the
 * same engine as InMemoryStore; each write locks one tenant and persists only
 * changed rows. Invalidation is an UPDATE, never a physical delete. Explicit
 * `deleteNode` is the governed erasure operation and removes dependent rows.
 */
export class PostgresMemoryStore implements MemoryStore, SnapshotCapable, HistoryCapable, AuditCapable, AuditVerifiable {
  private readonly pool: Pool | undefined;
  private readonly client: PostgresQueryClient;
  private readonly context = new AsyncLocalStorage<PostgresQueryClient>();
  readonly tenantId: string;
  private readonly auditKey: string | undefined;
  private readonly dimensions: number;

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

  private async load(db: PostgresQueryClient): Promise<{ engine: InMemoryStore; rows: Item[] }> {
    const rows = (await db.query("SELECT id, kind, metadata FROM memory_items WHERE tenant_key = $1 AND kind <> 'embedding' ORDER BY row_order", [this.tenantId])).rows as Item[];
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

  private async read<T>(work: (engine: InMemoryStore) => Promise<T>): Promise<T> {
    return this.transaction(async db => work((await this.load(db)).engine));
  }
  private async write<T>(work: (engine: InMemoryStore) => Promise<T>): Promise<T> {
    return this.transaction(async db => {
      const { engine, rows } = await this.load(db);
      const result = await work(engine);
      await this.persist(db, rows, engine);
      return result;
    }, true);
  }

  addNode(node: NewMemoryNode): Promise<MemoryNode> { return this.write(s => s.addNode(node)); }
  getNode(id: string): Promise<MemoryNode | undefined> { return this.read(s => s.getNode(id)); }
  listNodes(): Promise<MemoryNode[]> { return this.read(s => s.listNodes()); }
  updateNode(id: string, patch: Parameters<MemoryStore["updateNode"]>[1], event?: Parameters<MemoryStore["updateNode"]>[2]): Promise<MemoryNode> { return this.write(s => s.updateNode(id, patch, event)); }
  deleteNode(id: string): Promise<void> { return this.write(s => s.deleteNode(id)); }
  restoreNode(node: MemoryNode): Promise<void> { return this.write(s => s.restoreNode(node)); }
  restoreEdge(edge: MemoryEdge): Promise<void> { return this.write(s => s.restoreEdge(edge)); }
  addEdge(edge: Parameters<MemoryStore["addEdge"]>[0]): Promise<MemoryEdge> { return this.write(s => s.addEdge(edge)); }
  getEdges(id: string): Promise<MemoryEdge[]> { return this.read(s => s.getEdges(id)); }
  deleteEdge(id: string): Promise<void> { return this.write(s => s.deleteEdge(id)); }
  snapshot(): Promise<GraphSnapshot> { return this.read(s => s.snapshot()); }
  history(id: string): Promise<NodeVersion[]> { return this.read(s => s.history(id)); }
  getNodeAsOf(id: string, at: string): Promise<AsOfFact | undefined> { return this.read(s => s.getNodeAsOf(id, at)); }
  snapshotAsOf(at: string, options?: AsOfOptions): Promise<AsOfSnapshot> { return this.read(s => s.snapshotAsOf(at, options)); }
  historySnapshot(): Promise<GraphSnapshot & { versions: NodeVersion[] }> { return this.read(s => s.historySnapshot()); }
  restoreVersion(version: NodeVersion): Promise<void> { return this.write(s => s.restoreVersion(version)); }

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
    return this.transaction(async db => { const result = await mutate(); await this.appendAudit(db, describe(result)); return result; }, true);
  }
  async recordAuditEvent(event: AuditEvent): Promise<void> { await this.transaction(db => this.appendAudit(db, event), true); }
  private async appendAudit(db: PostgresQueryClient, event: AuditEvent): Promise<void> {
    const tenant = (await db.query("SELECT audit_count,audit_head FROM memory_tenants WHERE tenant_key=$1", [this.tenantId])).rows[0];
    const rows = (await db.query("SELECT prev,hash,event FROM memory_audit_events WHERE tenant_key=$1 ORDER BY seq", [this.tenantId])).rows;
    let prev = GENESIS;
    for (const [i, row] of rows.entries()) {
      const fault = linkFault({ prev: row.prev, hash: row.hash, event: object(row.event) }, prev, this.auditKey, i + 1, EVENT_LABELS);
      if (fault) throw new Error(`audit chain broken: ${fault}`);
      prev = row.hash;
    }
    if (Number(tenant.audit_count) !== rows.length || tenant.audit_head !== prev) throw new Error("audit chain broken: rows do not match the tenant's recorded head or count");
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
      const tenant = (await db.query("SELECT audit_count,audit_head FROM memory_tenants WHERE tenant_key=$1", [this.tenantId])).rows[0];
      if (tenant === undefined) return { ok: false, count: 0, line: 0, reason: `no tenant ${JSON.stringify(this.tenantId)} in this database` };
      const rows = (await db.query("SELECT seq,prev,hash,event FROM memory_audit_events WHERE tenant_key=$1 ORDER BY seq", [this.tenantId])).rows;
      let prev = GENESIS;
      for (const [i, row] of rows.entries()) {
        const event = object<AuditEvent>(row.event);
        const fault = linkFault({ prev: row.prev, hash: row.hash, event }, prev, this.auditKey, i + 1, EVENT_LABELS);
        if (fault) return { ok: false, count: rows.length, line: i + 1, reason: `${fault} (seq ${row.seq})` };
        opts.visit?.(event, i + 1);
        prev = row.hash;
      }
      const recorded = Number(tenant.audit_count);
      if (recorded !== rows.length || tenant.audit_head !== prev) {
        return { ok: false, count: rows.length, line: rows.length, reason: `the tenant row records ${recorded} event(s) and its own head, and the table does not end there: events were removed from the end, or the chain was rewritten` };
      }
      if (opts.head !== undefined && prev !== opts.head) {
        return { ok: false, count: rows.length, line: rows.length, reason: "the newest event does not match the anchored head: the trail was cut short or has diverged" };
      }
      return { ok: true, count: rows.length, head: prev };
    });
  }
}
