import { randomUUID } from "node:crypto";

import { compareRecency, effectiveConfidence, learnedAt } from "./decay.js";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

import Database from "better-sqlite3";

import { assertPatchMutable, assertRestorable } from "./immutable.js";
import { canonicalEdge, canonicalInstant, canonicalNew, canonicalNode, canonicalPatch } from "./instant.js";
import type {
  MemoryEdge,
  MemoryEmbedding,
  MemoryNode,
  MemoryQueryOptions,
  MemoryStore,
  NewMemoryNode,
  TemporalAnchor,
} from "./types/memory.js";

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const DEFAULT_DB_PATH = join(homedir(), ".al-buddy", "memory.db");

// ---------------------------------------------------------------------------
// Internal row shape returned by better-sqlite3
// ---------------------------------------------------------------------------

interface NodeRow {
  node_id: string;
  provenance: string;
  encryption_key_ref: string;
  memory_type: string;
  privacy_classification: string;
  retention_tier: string;
  content_text: string;
  content_structured_data: string | null;
  content_attachment_refs: string | null;
  contextual_metadata: string;
  temporal_anchors: string;
  valid_from: string;
  valid_to: string | null;
  confidence_weight: number;
  decay_rate: number;
  embedding: string | null;
  fts_rowid: number;
}

interface EmbeddingRow {
  node_id: string;
  model: string;
  model_version: string;
  dimensions: number;
  metric: string;
  vector: string;
  created_at: string;
}

interface EdgeRow {
  edge_id: string;
  source_node_id: string;
  target_node_id: string;
  created_at: string;
  relationship_type: string;
  strength: number;
  provenance: string;
}

// ---------------------------------------------------------------------------
// Row ↔ domain object mappers
// ---------------------------------------------------------------------------

function rowToNode(row: NodeRow): MemoryNode {
  return {
    nodeId: row.node_id,
    provenance: row.provenance as MemoryNode["provenance"],
    encryptionKeyRef: row.encryption_key_ref,
    memoryType: row.memory_type as MemoryNode["memoryType"],
    privacyClassification: row.privacy_classification as MemoryNode["privacyClassification"],
    retentionTier: row.retention_tier as MemoryNode["retentionTier"],
    content: {
      text: row.content_text,
      ...(row.content_structured_data !== null
        ? { structuredData: JSON.parse(row.content_structured_data) as Record<string, unknown> }
        : {}),
      ...(row.content_attachment_refs !== null
        ? { attachmentRefs: JSON.parse(row.content_attachment_refs) as string[] }
        : {}),
    },
    contextualMetadata: JSON.parse(row.contextual_metadata) as Record<string, unknown>,
    temporalAnchors: JSON.parse(row.temporal_anchors) as TemporalAnchor[],
    validFrom: row.valid_from,
    validTo: row.valid_to,
    confidenceWeight: row.confidence_weight,
    decayRate: row.decay_rate,
    ...(row.embedding !== null ? { embedding: JSON.parse(row.embedding) as number[] } : {}),
  };
}

/**
 * Turn an arbitrary query string into a safe FTS5 MATCH expression.
 *
 * The input may be a full natural-language sentence with commas, quotes, and
 * other FTS5 metacharacters. We extract word tokens (Unicode letters/digits),
 * wrap each as a quoted FTS5 string, and OR them together, so any term matching
 * is a hit. Returns `null` when there are no usable terms.
 */
function toFtsMatch(query: string): string | null {
  const tokens = query.match(/[\p{L}\p{N}]+/gu);
  if (!tokens || tokens.length === 0) return null;
  // Cap the term count to keep the query bounded; quote each term (a quoted
  // FTS5 string is a literal, immune to operator characters).
  const terms = tokens.slice(0, 16).map((t) => `"${t}"`);
  return terms.join(" OR ");
}

function rowToEmbedding(row: EmbeddingRow): MemoryEmbedding {
  return {
    nodeId: row.node_id,
    model: row.model,
    modelVersion: row.model_version,
    dimensions: row.dimensions,
    metric: row.metric as MemoryEmbedding["metric"],
    vector: JSON.parse(row.vector) as number[],
    createdAt: row.created_at,
  };
}

function rowToEdge(row: EdgeRow): MemoryEdge {
  return {
    edgeId: row.edge_id,
    sourceNodeId: row.source_node_id,
    targetNodeId: row.target_node_id,
    createdAt: row.created_at,
    relationshipType: row.relationship_type as MemoryEdge["relationshipType"],
    strength: row.strength,
    provenance: row.provenance as MemoryEdge["provenance"],
  };
}

// ---------------------------------------------------------------------------
// Schema migrations — indexed by target `user_version`, applied in order.
//
// Each entry brings the DB from version N to N+1. Adding a migration is how the
// schema evolves per GOV-TECH-001 (versioned migration + backward-compatible
// defaults). Never edit a shipped migration — append a new one.
// ---------------------------------------------------------------------------

/** v1 — base node/edge/FTS schema (the original 1.0.0 store). */
const MIGRATION_V1 = [
  `CREATE TABLE IF NOT EXISTS memory_nodes (
    node_id                 TEXT PRIMARY KEY,
    provenance              TEXT NOT NULL,
    encryption_key_ref      TEXT NOT NULL,
    memory_type             TEXT NOT NULL,
    privacy_classification  TEXT NOT NULL DEFAULT 'Private',
    retention_tier          TEXT NOT NULL DEFAULT 'FullRetention',
    content_text            TEXT NOT NULL,
    content_structured_data TEXT,
    content_attachment_refs TEXT,
    contextual_metadata     TEXT NOT NULL DEFAULT '{}',
    temporal_anchors        TEXT NOT NULL DEFAULT '[]',
    confidence_weight       REAL NOT NULL DEFAULT 1.0,
    decay_rate              REAL NOT NULL DEFAULT 0.0,
    embedding               TEXT,
    fts_rowid               INTEGER,
    created_at              TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_nodes_memory_type     ON memory_nodes (memory_type)`,
  `CREATE INDEX IF NOT EXISTS idx_nodes_privacy         ON memory_nodes (privacy_classification)`,
  `CREATE INDEX IF NOT EXISTS idx_nodes_retention       ON memory_nodes (retention_tier)`,
  `CREATE INDEX IF NOT EXISTS idx_nodes_confidence      ON memory_nodes (confidence_weight DESC)`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
    content_text,
    tokenize = 'unicode61'
  )`,
  `CREATE TABLE IF NOT EXISTS memory_edges (
    edge_id           TEXT PRIMARY KEY,
    source_node_id    TEXT NOT NULL REFERENCES memory_nodes(node_id) ON DELETE CASCADE,
    target_node_id    TEXT NOT NULL REFERENCES memory_nodes(node_id) ON DELETE CASCADE,
    created_at        TEXT NOT NULL,
    relationship_type TEXT NOT NULL,
    strength          REAL NOT NULL DEFAULT 1.0,
    provenance        TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_edges_source  ON memory_edges (source_node_id)`,
  `CREATE INDEX IF NOT EXISTS idx_edges_target  ON memory_edges (target_node_id)`,
];

/**
 * v2 (schema 1.1.0) — bi-temporal valid-time on nodes + a dedicated,
 * model-tagged embeddings table. Existing rows are backfilled so `valid_from`
 * defaults to their creation time and `valid_to` stays NULL (open / still true).
 */
const MIGRATION_V2 = [
  `ALTER TABLE memory_nodes ADD COLUMN valid_from TEXT`,
  `ALTER TABLE memory_nodes ADD COLUMN valid_to   TEXT`,
  `UPDATE memory_nodes SET valid_from = created_at WHERE valid_from IS NULL`,
  `CREATE INDEX IF NOT EXISTS idx_nodes_valid_from ON memory_nodes (valid_from)`,
  `CREATE INDEX IF NOT EXISTS idx_nodes_valid_to   ON memory_nodes (valid_to)`,
  `CREATE TABLE IF NOT EXISTS memory_embeddings (
    node_id       TEXT NOT NULL REFERENCES memory_nodes(node_id) ON DELETE CASCADE,
    model         TEXT NOT NULL,
    model_version TEXT NOT NULL,
    dimensions    INTEGER NOT NULL,
    metric        TEXT NOT NULL,
    vector        TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    PRIMARY KEY (node_id, model)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_embeddings_node ON memory_embeddings (node_id)`,
];

/** Ordered migrations; array length is the latest schema version. */
/**
 * v3 — the two indexes the 100k-fact measurement asked for: the FTS join
 * column, and a covering index for the no-query ORDER BY so LIMIT stops early
 * instead of sorting the table. The single-column confidence index is
 * subsumed by the covering one and dropped so the planner cannot prefer it.
 */
const MIGRATION_V3 = [
  `CREATE INDEX IF NOT EXISTS idx_nodes_fts_rowid ON memory_nodes (fts_rowid)`,
  `CREATE INDEX IF NOT EXISTS idx_nodes_rank      ON memory_nodes (confidence_weight DESC, created_at DESC)`,
  `DROP INDEX IF EXISTS idx_nodes_confidence`,
];

/**
 * v4 — the covering index follows the no-query ORDER BY, which gained node_id
 * as its final key (see NO_QUERY_ORDER). Without this the planner sorts ties
 * instead of stopping at LIMIT, which is the cost the v3 index was added to
 * avoid at 100k facts.
 */
const MIGRATION_V4 = [
  `CREATE INDEX IF NOT EXISTS idx_nodes_rank_v4 ON memory_nodes (confidence_weight DESC, created_at DESC, node_id DESC)`,
  `DROP INDEX IF EXISTS idx_nodes_rank`,
];

/**
 * v5 — one spelling per instant (see instant.ts). Validity bounds are the
 * values callers supply, so a store written before 0.4.0 can hold "…00Z" or an
 * offset, which a string comparison misplaces. Rewrite those to canonical UTC;
 * a value SQLite cannot parse is left exactly as it was. Creation anchors are
 * always written by the library itself and need no rewrite.
 */
const CANONICAL_GLOB = "'[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'";
const MIGRATION_V5 = ["valid_from", "valid_to"].map(
  (col) =>
    `UPDATE memory_nodes SET ${col} = strftime('%Y-%m-%dT%H:%M:%fZ', ${col})
       WHERE ${col} IS NOT NULL AND ${col} NOT GLOB ${CANONICAL_GLOB} AND strftime('%Y-%m-%dT%H:%M:%fZ', ${col}) IS NOT NULL`,
);
const MIGRATIONS = [MIGRATION_V1, MIGRATION_V2, MIGRATION_V3, MIGRATION_V4, MIGRATION_V5];

// ---------------------------------------------------------------------------
// SqliteMemoryStore
// ---------------------------------------------------------------------------

/**
 * Durable SQLite-backed MemoryStore.
 *
 * Persists to `~/.al-buddy/memory.db` by default. Pass a custom `dbPath`
 * in tests (or `:memory:`) to isolate test runs.
 *
 * Uses SQLite FTS5 for full-text search on node content.
 */
/**
 * The no-query order, in SQL and in the JS re-rank below — they must be the
 * same sort or a limited read is not the first page of an unlimited one.
 *
 * Reported from outside on 2026-09-14: the SQL read newest-first and the
 * re-rank then broke confidence ties oldest-first before truncating, so asking
 * for 5 of 230 equal-confidence facts returned five old ones from the middle of
 * the pool. Every fact with decayRate 0 shares confidence, so the tie-break was
 * deciding the whole result.
 *
 * `node_id` is the final key because `created_at` is milliseconds and a bulk
 * write shares one: without it the pool boundary — which rows SQLite hands over
 * at all — is arbitrary, and no JS sort can repair that.
 */
const NO_QUERY_ORDER = `ORDER BY confidence_weight DESC, created_at DESC, node_id DESC`;

/** With a query, SQLite hands JS this many candidates per requested result to re-rank with decay. */
const FTS_POOL_MULTIPLIER = 10;
const FTS_POOL_MIN = 200;
const FTS_POOL_UNLIMITED = -1; // SQLite: a negative LIMIT means no limit

export class SqliteMemoryStore implements MemoryStore {
  private readonly db: Database.Database;

  constructor(dbPath: string = DEFAULT_DB_PATH) {
    if (dbPath !== ":memory:") {
      // 0700 data dir + 0600 db file: lifelong memory is plaintext on disk, so
      // at minimum keep it owner-only against other local accounts. (ALB-SEC-015.)
      mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
    }
    this.db = new Database(dbPath);
    // WAL + synchronous=NORMAL: the standard setting for a local store. Readers
    // never block the writer, and a row insert no longer waits for an fsync
    // (durable at process crash; the last transactions can be lost only at
    // power loss). Measured: inserts went from ~1.7k/s to the README "Limits" figure.
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    if (dbPath !== ":memory:") {
      try {
        chmodSync(dbPath, 0o600);
      } catch {
        /* best-effort — a pre-existing looser file is repaired if permitted */
      }
    }
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  // -------------------------------------------------------------------------
  // Schema migration (idempotent)
  // -------------------------------------------------------------------------

  private migrate(): void {
    // IMMEDIATE takes the write lock BEFORE the version is read. Reading it
    // outside the lock let two processes opening a fresh file both start from
    // v0: one finished, the other then re-ran v1, failed on v2's ADD COLUMN, and
    // left a valid schema labelled v1 for ever (review 2026-09-14).
    const apply = this.db.transaction(() => {
      const current = this.db.pragma("user_version", { simple: true }) as number;
      for (let version = current; version < MIGRATIONS.length; version++) {
        for (const stmt of MIGRATIONS[version]!) this.db.prepare(stmt).run();
        // pragma value can't be parameterized; version is a trusted integer.
        this.db.pragma(`user_version = ${version + 1}`);
      }
    });
    apply.immediate();
  }

  // -------------------------------------------------------------------------
  // Node operations
  // -------------------------------------------------------------------------

  async addNode(input: NewMemoryNode): Promise<MemoryNode> {
    const node = canonicalNew(input);
    const nodeId = randomUUID();
    const now = new Date().toISOString();
    const temporalAnchors: TemporalAnchor[] = [{ timestamp: now, event: "created" }];
    // Valid-time defaults: true from creation, open-ended.
    const validFrom = node.validFrom ?? now;
    const validTo = node.validTo ?? null;

    // FTS row and node row land together or not at all: a crash between the
    // two used to leave an orphan FTS row — a ghost search hit with no node
    // behind it (review 2026-09-01, §3).
    const insertPair = this.db.transaction((): void => {
    // Insert into FTS5 first to get the rowid for back-reference
    const ftsResult = this.db
      .prepare(`INSERT INTO memory_fts (content_text) VALUES (?)`)
      .run(node.content.text);
    const ftsRowid = ftsResult.lastInsertRowid;

    this.db
      .prepare(
        `INSERT INTO memory_nodes (
          node_id, provenance, encryption_key_ref, memory_type,
          privacy_classification, retention_tier,
          content_text, content_structured_data, content_attachment_refs,
          contextual_metadata, temporal_anchors, valid_from, valid_to,
          confidence_weight, decay_rate, embedding,
          fts_rowid, created_at
        ) VALUES (
          @nodeId, @provenance, @encryptionKeyRef, @memoryType,
          @privacyClassification, @retentionTier,
          @contentText, @contentStructuredData, @contentAttachmentRefs,
          @contextualMetadata, @temporalAnchors, @validFrom, @validTo,
          @confidenceWeight, @decayRate, @embedding,
          @ftsRowid, @createdAt
        )`,
      )
      .run({
        nodeId,
        provenance: node.provenance,
        encryptionKeyRef: node.encryptionKeyRef,
        memoryType: node.memoryType,
        privacyClassification: node.privacyClassification,
        retentionTier: node.retentionTier,
        contentText: node.content.text,
        contentStructuredData: node.content.structuredData
          ? JSON.stringify(node.content.structuredData)
          : null,
        contentAttachmentRefs: node.content.attachmentRefs
          ? JSON.stringify(node.content.attachmentRefs)
          : null,
        contextualMetadata: JSON.stringify(node.contextualMetadata),
        temporalAnchors: JSON.stringify(temporalAnchors),
        validFrom,
        validTo,
        confidenceWeight: node.confidenceWeight,
        decayRate: node.decayRate,
        embedding: node.embedding ? JSON.stringify(node.embedding) : null,
        ftsRowid,
        createdAt: now,
      });
    });
    insertPair();

    return { ...node, nodeId, temporalAnchors, validFrom, validTo };
  }

  async getNode(nodeId: string): Promise<MemoryNode | undefined> {
    const row = this.db.prepare(`SELECT * FROM memory_nodes WHERE node_id = ?`).get(nodeId) as
      | NodeRow
      | undefined;
    return row !== undefined ? rowToNode(row) : undefined;
  }

  /** Verbatim insert for round-trip import — identity and anchors preserved. */
  async restoreNode(input: MemoryNode): Promise<void> {
    const node = canonicalNode(input);
    // One transaction. Over an existing fact this is an UPDATE in place: it used
    // to delete and reinsert the row, and the foreign-key cascade silently took
    // every edge and embedding with it (review 2026-09-14). Content cannot
    // differ (assertRestorable), so the full-text row is left as it is.
    const restore = this.db.transaction((): void => {
      const row = this.db.prepare(`SELECT * FROM memory_nodes WHERE node_id = ?`).get(node.nodeId) as NodeRow | undefined;
      assertRestorable(node, row ? rowToNode(row) : undefined);
      // The same anchor the ordering reads, by the same function, so the column
      // and the re-rank can never drift apart.
      const createdAt = learnedAt(node);
      const mutable = {
        nodeId: node.nodeId,
        memoryType: node.memoryType,
        privacyClassification: node.privacyClassification,
        retentionTier: node.retentionTier,
        contextualMetadata: JSON.stringify(node.contextualMetadata),
        temporalAnchors: JSON.stringify(node.temporalAnchors),
        validFrom: node.validFrom,
        validTo: node.validTo,
        confidenceWeight: node.confidenceWeight,
        decayRate: node.decayRate,
        embedding: node.embedding ? JSON.stringify(node.embedding) : null,
        createdAt,
      };

      if (row) {
        this.db
          .prepare(
            `UPDATE memory_nodes SET
               memory_type = @memoryType, privacy_classification = @privacyClassification,
               retention_tier = @retentionTier, contextual_metadata = @contextualMetadata,
               temporal_anchors = @temporalAnchors, valid_from = @validFrom, valid_to = @validTo,
               confidence_weight = @confidenceWeight, decay_rate = @decayRate,
               embedding = @embedding, created_at = @createdAt
             WHERE node_id = @nodeId`,
          )
          .run(mutable);
        return;
      }

      const ftsResult = this.db
        .prepare(`INSERT INTO memory_fts (content_text) VALUES (?)`)
        .run(node.content.text);
      this.db
        .prepare(
          `INSERT INTO memory_nodes (
            node_id, provenance, encryption_key_ref, memory_type,
            privacy_classification, retention_tier,
            content_text, content_structured_data, content_attachment_refs,
            contextual_metadata, temporal_anchors, valid_from, valid_to,
            confidence_weight, decay_rate, embedding,
            fts_rowid, created_at
          ) VALUES (
            @nodeId, @provenance, @encryptionKeyRef, @memoryType,
            @privacyClassification, @retentionTier,
            @contentText, @contentStructuredData, @contentAttachmentRefs,
            @contextualMetadata, @temporalAnchors, @validFrom, @validTo,
            @confidenceWeight, @decayRate, @embedding,
            @ftsRowid, @createdAt
          )`,
        )
        .run({
          ...mutable,
          provenance: node.provenance,
          encryptionKeyRef: node.encryptionKeyRef,
          contentText: node.content.text,
          contentStructuredData: node.content.structuredData ? JSON.stringify(node.content.structuredData) : null,
          contentAttachmentRefs: node.content.attachmentRefs ? JSON.stringify(node.content.attachmentRefs) : null,
          ftsRowid: ftsResult.lastInsertRowid,
        });
    });
    restore();
  }

  /** Verbatim edge insert for round-trip import (idempotent by edgeId). */
  async restoreEdge(input: MemoryEdge): Promise<void> {
    const edge = canonicalEdge(input);
    // One transaction: a replacement that fails (a missing endpoint) must not
    // have already deleted the edge it was replacing.
    this.db.transaction(() => {
    this.db.prepare(`DELETE FROM memory_edges WHERE edge_id = ?`).run(edge.edgeId);
    this.db
      .prepare(
        `INSERT INTO memory_edges
          (edge_id, source_node_id, target_node_id, created_at, relationship_type, strength, provenance)
         VALUES
          (@edgeId, @sourceNodeId, @targetNodeId, @createdAt, @relationshipType, @strength, @provenance)`,
      )
      .run({
        edgeId: edge.edgeId,
        sourceNodeId: edge.sourceNodeId,
        targetNodeId: edge.targetNodeId,
        createdAt: edge.createdAt,
        relationshipType: edge.relationshipType,
        strength: edge.strength,
        provenance: edge.provenance,
      });
    })();
  }

  async listNodes(): Promise<MemoryNode[]> {
    // No filters at all: this is enumeration (export, backup), not recall.
    const rows = this.db.prepare(`SELECT * FROM memory_nodes ORDER BY created_at ASC, node_id ASC`).all() as NodeRow[];
    return rows.map(rowToNode);
  }

  async searchNodes(options: MemoryQueryOptions): Promise<MemoryNode[]> {
    // --- Full-text search via FTS5 (keep the BM25 rank — it IS the relevance) ---
    // The match is a JOIN, not an IN-list of rowids: a common term over a
    // large store matched more rows than SQLite allows bound variables
    // (found at 100k facts: "too many SQL variables"), and the join lets
    // SQLite order by rank and stop at the candidate pool instead of
    // materialising every hit.
    let match: string | null = null;
    const conditions: string[] = [];
    const params: Record<string, unknown> = {};
    if (options.query !== undefined) {
      // The raw query may be a natural-language sentence; FTS5 MATCH treats
      // commas/quotes/etc. as query syntax, so build a safe OR-of-terms.
      match = toFtsMatch(options.query);
      if (match === null) return []; // no usable search terms
      params["match"] = match;
    }

    if (options.memoryType !== undefined) {
      const types = Array.isArray(options.memoryType) ? options.memoryType : [options.memoryType];
      const placeholders = types.map((_, i) => `@mt${i}`).join(", ");
      types.forEach((t, i) => {
        params[`mt${i}`] = t;
      });
      conditions.push(`memory_type IN (${placeholders})`);
    }

    if (options.privacyClassification !== undefined && options.privacyClassification.length > 0) {
      const placeholders = options.privacyClassification.map((_, i) => `@pc${i}`).join(", ");
      options.privacyClassification.forEach((pc, i) => {
        params[`pc${i}`] = pc;
      });
      conditions.push(`privacy_classification IN (${placeholders})`);
    } else {
      // Governance boundary: Sealed nodes never surface unless explicitly requested.
      conditions.push(`privacy_classification != 'Sealed'`);
    }

    if (options.retentionTier !== undefined && options.retentionTier.length > 0) {
      const placeholders = options.retentionTier.map((_, i) => `@rt${i}`).join(", ");
      options.retentionTier.forEach((rt, i) => {
        params[`rt${i}`] = rt;
      });
      conditions.push(`retention_tier IN (${placeholders})`);
    }
    else {
      // Schema §3.5: Archived is cold storage and PendingDeletion is on its way
      // out — neither belongs in active context unless asked for by name
      // (review 2026-09-01, idea 12).
      conditions.push(`retention_tier NOT IN ('Archived', 'PendingDeletion')`);
    }

    if (options.minConfidence !== undefined) {
      conditions.push(`confidence_weight >= @minConfidence`);
      params["minConfidence"] = options.minConfidence;
    }

    if (options.tags !== undefined && options.tags.length > 0) {
      // In SQL, before any pool or LIMIT: filtering after the limit returned too
      // few (or no) rows whenever the top-N by confidence lacked the tag.
      const placeholders = options.tags.map((_, i) => `@tg${i}`).join(", ");
      options.tags.forEach((t, i) => {
        params[`tg${i}`] = t;
      });
      conditions.push(
        `json_type(contextual_metadata, '$.tags') = 'array' AND EXISTS (SELECT 1 FROM json_each(contextual_metadata, '$.tags') WHERE json_each.value IN (${placeholders}))`,
      );
    }

    if (options.validAt !== undefined) {
      // Valid-time window contains the instant: [valid_from, valid_to), null = open.
      conditions.push(`valid_from <= @validAt AND (valid_to IS NULL OR valid_to > @validAt)`);
      params["validAt"] = canonicalInstant(options.validAt, "validAt");
    }

    if (options.after !== undefined) {
      conditions.push(`created_at > (SELECT created_at FROM memory_nodes WHERE node_id = @after)`);
      params["after"] = options.after;
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    // With a query, ordering happens by BM25 relevance below — the SQL LIMIT
    // would truncate by confidence first, cutting off relevant hits.
    // Numeric by construction: every caller clamps, and a string that reached
    // here would be interpolated into SQL (review 2026-09-01, F5).
    const limitN = options.limit !== undefined ? Math.max(0, Math.floor(Number(options.limit))) : undefined;
    // Ranking happens in JS so decay can apply (decay.ts): the SQL limit would
    // cut by stored confidence before age had a say. With a query, SQLite
    // orders by BM25 and hands over a candidate pool (a multiple of the
    // limit) that JS re-ranks with decay; without one, the whole valid set is
    // read — at a store of hundreds to low thousands that is cheap, and the
    // measured cost at 100k facts is in README "Limits".
    let rows: (NodeRow & { fts_rank?: number })[];
    if (match !== null) {
      // The pool's ORDER BY has to end the same way the JS re-rank does, or a
      // limited read is a page of a DIFFERENT list: with hundreds of equally
      // relevant hits, SQLite would hand over the first 200 by rowid (the
      // oldest) and the re-rank could only pick the newest of those.
      const pool = limitN !== undefined && Number.isFinite(limitN) ? Math.max(limitN * FTS_POOL_MULTIPLIER, FTS_POOL_MIN) : FTS_POOL_UNLIMITED;
      params["pool"] = pool;
      rows = this.db
        .prepare(
          `SELECT n.*, f.rank AS fts_rank FROM memory_nodes n
             JOIN (SELECT rowid AS fts_id, rank FROM memory_fts WHERE content_text MATCH @match) f ON n.fts_rowid = f.fts_id
             ${where} ORDER BY f.rank ASC, n.confidence_weight DESC, n.created_at DESC, n.node_id DESC
             LIMIT @pool`,
        )
        .all(params) as (NodeRow & { fts_rank: number })[];
    } else if (limitN !== undefined && Number.isFinite(limitN)) {
      // No query, but a limit: read a candidate pool ordered by stored
      // confidence and re-rank it with decay. Decay only lowers, so a fact
      // outside the pool can outrank a pool member only when the whole pool
      // has decayed below it — approximate past the pool, exact within it.
      params["pool"] = Math.max(limitN * FTS_POOL_MULTIPLIER, FTS_POOL_MIN);
      rows = this.db
        .prepare(`SELECT * FROM memory_nodes ${where} ${NO_QUERY_ORDER} LIMIT @pool`)
        .all(params) as NodeRow[];
    } else {
      rows = this.db
        .prepare(`SELECT * FROM memory_nodes ${where} ${NO_QUERY_ORDER}`)
        .all(params) as NodeRow[];
    }

    const now = Date.now();
    const nodes = rows.map((row) => ({ row, node: rowToNode(row), eff: 0 }));
    for (const n of nodes) n.eff = effectiveConfidence(n.node, now);
    if (match !== null) {
      // Ascending BM25 (more negative = better), then effective confidence, then
      // the same last word as every other read. Two near-identical texts score
      // the same BM25 and, at decayRate 0, the same confidence — without the
      // final key which of them a `limit` keeps is the row order SQLite happened
      // to return.
      nodes.sort(
        (a, b) =>
          (a.row.fts_rank ?? 0) - (b.row.fts_rank ?? 0) || b.eff - a.eff || compareRecency(a.node, b.node),
      );
    } else {
      nodes.sort((a, b) => b.eff - a.eff || compareRecency(a.node, b.node));
    }
    if (limitN !== undefined && Number.isFinite(limitN)) nodes.length = Math.min(nodes.length, limitN);

    return nodes.map((n) => n.node);
  }

  async updateNode(
    nodeId: string,
    // Reference the interface's patch type so it can never drift from it.
    input: Parameters<MemoryStore["updateNode"]>[1],
    anchorEvent: Parameters<MemoryStore["updateNode"]>[2] = "modified",
  ): Promise<MemoryNode> {
    assertPatchMutable(input);
    const patch = canonicalPatch(input);
    // Read-modify-write under the write lock (IMMEDIATE): two processes that
    // both read the row and then each wrote their reconstruction used to lose
    // one change and its anchor.
    const apply = this.db.transaction((): MemoryNode => {
      const existingRow = this.db
        .prepare(`SELECT * FROM memory_nodes WHERE node_id = ?`)
        .get(nodeId) as NodeRow | undefined;
      if (existingRow === undefined) {
        throw new Error(`MemoryNode not found: ${nodeId}`);
      }

      const existing = rowToNode(existingRow);
      const now = new Date().toISOString();
      const newAnchors: TemporalAnchor[] = [
        ...existing.temporalAnchors,
        { timestamp: now, event: anchorEvent },
      ];

      const updated: MemoryNode = {
        ...existing,
        ...patch,
        nodeId,
        temporalAnchors: newAnchors,
      };

      // No full-text update: content is immutable (assertPatchMutable above), so
      // the indexed text can never drift from the row.

      this.db
        .prepare(
          `UPDATE memory_nodes SET
            memory_type             = @memoryType,
            privacy_classification  = @privacyClassification,
            retention_tier          = @retentionTier,
            content_text            = @contentText,
            content_structured_data = @contentStructuredData,
            content_attachment_refs = @contentAttachmentRefs,
            contextual_metadata     = @contextualMetadata,
            temporal_anchors        = @temporalAnchors,
            valid_from              = @validFrom,
            valid_to                = @validTo,
            confidence_weight       = @confidenceWeight,
            decay_rate              = @decayRate,
            embedding               = @embedding
          WHERE node_id = @nodeId`,
        )
        .run({
          nodeId,
          memoryType: updated.memoryType,
          privacyClassification: updated.privacyClassification,
          retentionTier: updated.retentionTier,
          contentText: updated.content.text,
          contentStructuredData: updated.content.structuredData
            ? JSON.stringify(updated.content.structuredData)
            : null,
          contentAttachmentRefs: updated.content.attachmentRefs
            ? JSON.stringify(updated.content.attachmentRefs)
            : null,
          contextualMetadata: JSON.stringify(updated.contextualMetadata),
          temporalAnchors: JSON.stringify(newAnchors),
          validFrom: updated.validFrom,
          validTo: updated.validTo,
          confidenceWeight: updated.confidenceWeight,
          decayRate: updated.decayRate,
          embedding: updated.embedding ? JSON.stringify(updated.embedding) : null,
        });

      return updated;
    });
    return apply.immediate();
  }

  async deleteNode(nodeId: string): Promise<void> {
    // One transaction: a crash between the two deletes used to leave a readable
    // fact that keyword search could never find again.
    this.db.transaction(() => {
      const row = this.db
        .prepare(`SELECT fts_rowid FROM memory_nodes WHERE node_id = ?`)
        .get(nodeId) as Pick<NodeRow, "fts_rowid"> | undefined;
      if (row !== undefined) {
        this.db.prepare(`DELETE FROM memory_fts WHERE rowid = ?`).run(row.fts_rowid);
      }
      // ON DELETE CASCADE clears memory_edges and memory_embeddings.
      this.db.prepare(`DELETE FROM memory_nodes WHERE node_id = ?`).run(nodeId);
    })();
  }

  // -------------------------------------------------------------------------
  // Edge operations
  // -------------------------------------------------------------------------

  async addEdge(edge: Omit<MemoryEdge, "edgeId" | "createdAt">): Promise<MemoryEdge> {
    const edgeId = randomUUID();
    const createdAt = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO memory_edges
          (edge_id, source_node_id, target_node_id, created_at, relationship_type, strength, provenance)
         VALUES
          (@edgeId, @sourceNodeId, @targetNodeId, @createdAt, @relationshipType, @strength, @provenance)`,
      )
      .run({
        edgeId,
        sourceNodeId: edge.sourceNodeId,
        targetNodeId: edge.targetNodeId,
        createdAt,
        relationshipType: edge.relationshipType,
        strength: edge.strength,
        provenance: edge.provenance,
      });

    return { ...edge, edgeId, createdAt };
  }

  async getEdges(nodeId: string): Promise<MemoryEdge[]> {
    const rows = this.db
      .prepare(`SELECT * FROM memory_edges WHERE source_node_id = ? OR target_node_id = ?`)
      .all(nodeId, nodeId) as EdgeRow[];
    return rows.map(rowToEdge);
  }

  async deleteEdge(edgeId: string): Promise<void> {
    this.db.prepare(`DELETE FROM memory_edges WHERE edge_id = ?`).run(edgeId);
  }

  // -------------------------------------------------------------------------
  // Embedding operations — model-tagged, disposable vector cache
  // -------------------------------------------------------------------------

  async setEmbedding(embedding: Omit<MemoryEmbedding, "createdAt">): Promise<MemoryEmbedding> {
    const createdAt = new Date().toISOString();
    // Upsert on (node_id, model): re-embedding a node with the same model
    // replaces the vector; a different model coexists as its own row.
    this.db
      .prepare(
        `INSERT INTO memory_embeddings
          (node_id, model, model_version, dimensions, metric, vector, created_at)
         VALUES
          (@nodeId, @model, @modelVersion, @dimensions, @metric, @vector, @createdAt)
         ON CONFLICT(node_id, model) DO UPDATE SET
          model_version = excluded.model_version,
          dimensions    = excluded.dimensions,
          metric        = excluded.metric,
          vector        = excluded.vector,
          created_at    = excluded.created_at`,
      )
      .run({
        nodeId: embedding.nodeId,
        model: embedding.model,
        modelVersion: embedding.modelVersion,
        dimensions: embedding.dimensions,
        metric: embedding.metric,
        vector: JSON.stringify(embedding.vector),
        createdAt,
      });

    return { ...embedding, createdAt };
  }

  async getEmbeddings(nodeId: string): Promise<MemoryEmbedding[]> {
    const rows = this.db
      .prepare(`SELECT * FROM memory_embeddings WHERE node_id = ? ORDER BY model ASC`)
      .all(nodeId) as EmbeddingRow[];
    return rows.map(rowToEmbedding);
  }

  async listEmbeddings(model: string): Promise<MemoryEmbedding[]> {
    const rows = this.db
      .prepare(`SELECT * FROM memory_embeddings WHERE model = ?`)
      .all(model) as EmbeddingRow[];
    return rows.map(rowToEmbedding);
  }

  async deleteEmbeddings(nodeId: string, model?: string): Promise<void> {
    if (model !== undefined) {
      this.db
        .prepare(`DELETE FROM memory_embeddings WHERE node_id = ? AND model = ?`)
        .run(nodeId, model);
      return;
    }
    this.db.prepare(`DELETE FROM memory_embeddings WHERE node_id = ?`).run(nodeId);
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /** Close the underlying database connection. Call in tests and on process exit. */
  close(): void {
    this.db.close();
  }
}
