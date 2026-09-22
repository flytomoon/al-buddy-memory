import { randomUUID } from "node:crypto";

import { compareRecency, effectiveConfidence, learnedAt } from "./decay.js";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

import Database from "better-sqlite3";

import { AUDIT_EVENTS_SCHEMA, AuditEventTable } from "./governance/audit-table.js";
import type { AuditCapable, AuditEvent } from "./governance/audit.js";
import { queryTokens } from "./query-filter.js";
import { buildSnapshotAsOf, mutableState, mutableStatesEqual, nodeAsOf } from "./history.js";
import { MIGRATION_V8, insertVersion, readAllVersions, readNodeVersions, restoreSqliteVersion } from "./sqlite-history.js";
import { retryWhileBusy } from "./sqlite-busy.js";
import { assertPatchMutable, assertRestorable, edgeRestoreIsNoop } from "./immutable.js";
import { assertAnchorEvent, assertEdge, canonicalEdge, canonicalInstant, canonicalNew, canonicalNode, canonicalPatch, instantMs } from "./instant.js";
import type {
  AsOfSnapshot,
  GraphSnapshot,
  HistoryCapable,
  MemoryEdge,
  MemoryEmbedding,
  MemoryNode,
  MemoryQueryOptions,
  MemoryStore,
  NewMemoryNode,
  NodeVersion,
  SnapshotCapable,
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
  /** learnedAt(node), written from the created anchor; the ranking's recency key. */
  created_at: string;
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
  const tokens = queryTokens(query);
  if (tokens.length === 0) return null;
  // Capped by queryTokens to keep the query bounded; quote each term (a quoted
  // FTS5 string is a literal, immune to operator characters).
  return tokens.map((t) => `"${t}"`).join(" OR ");
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
 * v5 — one spelling per instant (see instant.ts), in JavaScript. Validity bounds
 * are values callers supplied, and 0.3.3's restoreNode stored creation anchors
 * verbatim, so a store written before 0.4.0 can hold offsets, "…00Z",
 * sub-millisecond fractions or lowercase separators. The SQL sort key created_at
 * and the validity columns are rewritten from the same instantMs() the JS ranking
 * uses — SQLite's strftime rounds fractions where JS truncates, and cannot read a
 * lowercase "t" at all, which left SQL and JS disagreeing about a page (Astra,
 * final confirmation, 2026-09-15). The anchors themselves stay verbatim: they are
 * history. A value with no instant to find is left exactly as it was.
 */
const MIGRATION_V5 = (db: Database.Database): void => {
  const canonical = (value: string | null): string | null => {
    const ms = instantMs(value);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : value;
  };
  const rows = db.prepare(`SELECT node_id, valid_from, valid_to, created_at, temporal_anchors FROM memory_nodes`).all() as {
    node_id: string; valid_from: string; valid_to: string | null; created_at: string; temporal_anchors: string;
  }[];
  const update = db.prepare(`UPDATE memory_nodes SET valid_from = ?, valid_to = ?, created_at = ? WHERE node_id = ?`);
  for (const r of rows) {
    let learned: string | undefined;
    try {
      learned = (JSON.parse(r.temporal_anchors) as { event?: string; timestamp?: string }[]).find((a) => a.event === "created")?.timestamp;
    } catch {
      learned = undefined;
    }
    const validFrom = canonical(r.valid_from)!;
    const validTo = canonical(r.valid_to);
    // No instant to find: the sort key becomes "", which sorts oldest in SQL exactly as
    // compareRecency sorts such a fact in JS. The anchor itself is untouched.
    const createdAt = Number.isFinite(instantMs(learned ?? r.valid_from)) ? canonical(learned ?? r.valid_from)! : "";
    if (validFrom !== r.valid_from || validTo !== r.valid_to || createdAt !== r.created_at) update.run(validFrom, validTo, createdAt, r.node_id);
  }
};
/**
 * v6 — a place for the database to say what it is. One key matters today:
 * `scope`, the project name this file belongs to. Filenames are lossy (two
 * scopes could sanitise to one name before 0.4.2 — R1, release review
 * 2026-09-18); the scope written inside the file is not, so a store opened
 * under the wrong name is refused instead of silently shared.
 */
const MIGRATION_V6 = [
  `CREATE TABLE IF NOT EXISTS memory_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
];

/**
 * v7 — `audit_events`, the governance trail inside the database it describes,
 * so a mutation's event can be committed in the mutation's own transaction.
 *
 * An existing database gets an empty table and nothing else. JSONL logs beside
 * it are NOT adopted: their chain was computed under whatever key that writer
 * held, and copying records in would mint a new chain that claims to attest to
 * a period it never witnessed. The two cover different periods and
 * `al-buddy-memory verify-audit <db>` reports both.
 */
const MIGRATION_V7 = AUDIT_EVENTS_SCHEMA;

/**
 * One migration statement, tolerating the one way a replayed migration can
 * fail on a schema that is already correct.
 *
 * `sqlite3 .dump` — a normal way to back up a SQLite database, and the one most
 * people reach for — does not carry `user_version`. A restore is therefore a
 * modern schema labelled v0, so the whole chain replays over it: every
 * `CREATE ... IF NOT EXISTS` is a no-op, the one backfill is `WHERE ... IS
 * NULL`, and the only statement that throws is `ADD COLUMN` on a column the
 * dump already created. The restored database then could not be opened at all
 * ("duplicate column name: valid_from") — measured 2026-09-19, and the same
 * statement had already left a store stranded once before, when two processes
 * opened a fresh file at the same moment (review 2026-09-14).
 *
 * A column that is already there is precisely what `ADD COLUMN` wanted, so it
 * is treated as done rather than as a failure. Nothing else is swallowed:
 * another error on an ADD COLUMN, or any error on any other statement, still
 * aborts the transaction and leaves the version where it was.
 */
function runMigrationStep(db: Database.Database, stmt: string): void {
  try {
    db.prepare(stmt).run();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/\bADD COLUMN\b/i.test(stmt) && /duplicate column name/i.test(message)) return;
    throw err;
  }
}

const MIGRATIONS: (string[] | ((db: Database.Database) => void))[] = [MIGRATION_V1, MIGRATION_V2, MIGRATION_V3, MIGRATION_V4, MIGRATION_V5, MIGRATION_V6, MIGRATION_V7, MIGRATION_V8];

/** The `user_version` a store is brought up to on open. */
export const SCHEMA_VERSION = MIGRATIONS.length;

export interface SqliteMemoryStoreOptions {
  /**
   * The scope (project) this file holds. Recorded the first time it is opened;
   * from then on, opening the same file under a different scope throws rather
   * than mixing two projects' facts. Leave it out and nothing is recorded or
   * checked — a plain store has no scope to disagree about.
   */
  scope?: string;
  /**
   * HMAC key for the `audit_events` chain. Without one the chain catches
   * accidental damage and careless edits but not a deliberate rewrite, because
   * anyone who can write the file can recompute it. With one, keep it somewhere
   * other than beside the database — the same advice as for a file log.
   *
   * Changing it makes the existing chain unverifiable and the store will refuse
   * to extend it, which is the correct refusal and not a recoverable state.
   */
  auditKey?: string;
}

/** The scope recorded inside a database file, or `null` if none is — without migrating it. */
export function readRecordedScope(dbPath: string): string | null {
  let db: Database.Database | undefined;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const row = db.prepare(`SELECT value FROM memory_meta WHERE key = 'scope'`).get() as { value?: string } | undefined;
    return typeof row?.value === "string" ? row.value : null;
  } catch {
    // No file, no meta table (written before v6), or unreadable: nothing recorded.
    return null;
  } finally {
    db?.close();
  }
}

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

export class SqliteMemoryStore implements MemoryStore, SnapshotCapable, AuditCapable, HistoryCapable {
  private readonly db: Database.Database;
  /** The `audit_events` chain on this connection. Built after migration, so the table exists. */
  private readonly auditTable: AuditEventTable;
  /**
   * The event the mutation now running must commit with, if any. Set by
   * `auditedMutation` for the duration of one store call and consumed inside
   * that call's transaction — see `mutation()`.
   */
  private pendingAudit: { describe: (result: unknown) => AuditEvent; written: boolean } | null = null;

  constructor(dbPath: string = DEFAULT_DB_PATH, options: SqliteMemoryStoreOptions = {}) {
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
    //
    // Retried while busy: better-sqlite3's timeout covers statements, not the
    // exclusive lock the journal-mode switch needs, so two processes opening one
    // database together used to fail outright (B1, release review 2026-09-18).
    //
    // A short wait per try, not the 5 s statement default: the retry loop does
    // the waiting, and stacking the two would put a minute between a locked
    // database and the error that explains it. Worst case here is a few seconds,
    // then the real SQLITE_BUSY.
    this.db.pragma("busy_timeout = 250");
    retryWhileBusy(() => this.db.pragma("journal_mode = WAL"));
    this.db.pragma("synchronous = NORMAL");
    if (dbPath !== ":memory:") {
      try {
        chmodSync(dbPath, 0o600);
      } catch {
        /* best-effort — a pre-existing looser file is repaired if permitted */
      }
    }
    retryWhileBusy(() => this.db.pragma("journal_mode = WAL"));
    this.db.pragma("foreign_keys = ON");
    retryWhileBusy(() => this.migrate());
    this.auditTable = new AuditEventTable(this.db, options.auditKey);
    // Opening is over; ordinary statements get the ordinary wait.
    this.db.pragma("busy_timeout = 5000");
    if (options.scope !== undefined) this.claimScope(options.scope);
  }

  // -------------------------------------------------------------------------
  // The audit trail, in the same transaction as the fact (AuditCapable)
  // -------------------------------------------------------------------------

  /**
   * Every mutating method's transaction, in one place, so that every one of
   * them can carry an audit event and none can be forgotten.
   *
   * `IMMEDIATE`, always: the chain's tail is read inside this transaction and
   * extended in it, and a deferred transaction that upgrades to a write can
   * have read a stale tail. Holding the write lock from the first statement is
   * what makes two processes' appends a total order rather than a fork.
   *
   * Measured rather than assumed, 2026-09-19: switched to `.deferred()`, the
   * whole suite still passes — the only mutation it races is `addNode`, whose
   * first statement is already a write — and a two-process `updateNode` race
   * does NOT fork the chain either. What it does is lose writes: 15-20% of them
   * fail with "database is locked" and never land. So the earlier claim here
   * that a deferred transaction is "not a chain" was stronger than the
   * evidence; the real cost is dropped writes, and it is still the wrong
   * transaction to use. Nothing in the suite would catch a change back to
   * `.deferred()` — see `src/sqlite-memory-store.test.ts`, *every writer's
   * update lands under contention*, which now would.
   */
  private mutation<T>(body: () => T): T {
    const run = this.db.transaction((): T => {
      const out = body();
      const pending = this.pendingAudit;
      if (pending !== null && !pending.written) {
        // Last, so the event describes a change that has actually been made.
        // If this throws, the whole transaction rolls back: no fact, no event.
        this.auditTable.append(pending.describe(out));
        pending.written = true;
      }
      return out;
    });
    return run.immediate();
  }

  async auditedMutation<T>(mutate: () => Promise<T>, describe: (result: T) => AuditEvent): Promise<T> {
    if (this.pendingAudit !== null) {
      throw new Error("al-buddy-memory: an audited mutation is already in flight on this store; they must not overlap");
    }
    // Verify the chain before the transaction opens, not inside it: the check
    // is one pass over the table and it would otherwise run under the write
    // lock on this store's first audited write.
    this.auditTable.ensureChecked();
    const pending = { describe: describe as (result: unknown) => AuditEvent, written: false };
    this.pendingAudit = pending;
    try {
      const result = await mutate();
      // Belt and braces, and it is a DETECTOR, not a preventer: it runs after
      // `mutate()` returned, so a method that skipped `mutation()` has already
      // committed by the time this fires. The caller is told, loudly, and the
      // fact is in the database with nothing attesting to it — demonstrated by
      // Fable 5.1 on 2026-09-19 with a deliberately un-transacted `addEdge`.
      // What makes the guarantee hold is the enumeration, not this line: all
      // nine mutators of `MemoryStore` go through `mutation()`, so nothing
      // reaches here. This exists so that if a tenth is ever added and forgets,
      // it fails on its first call in the first test rather than silently.
      // It cannot protect `setEmbedding` or `deleteEmbeddings`, which are not
      // audited on any path and never enter this method at all.
      if (!pending.written) {
        throw new Error("al-buddy-memory: that store call committed without carrying its audit event; it does not run through mutation()");
      }
      return result;
    } finally {
      this.pendingAudit = null;
    }
  }

  async recordAuditEvent(event: AuditEvent): Promise<void> {
    // Same reason as `auditedMutation`: the one-time chain check is a full pass,
    // and inside the transaction below it would hold the write lock. A process
    // whose FIRST governed call is a read reaches the check here rather than
    // there, so it has to be lifted out in both places.
    this.auditTable.ensureChecked();
    // A refusal or a read has no fact to be atomic with: its own transaction.
    this.db.transaction(() => this.auditTable.append(event)).immediate();
  }

  async auditHead(): Promise<string> {
    return this.auditTable.head();
  }

  /**
   * Record which project this file holds, or refuse it to a different one.
   * A file written before 0.4.2 records nothing, so the first scope to open it
   * claims it — that is what keeps an existing store working. After that the
   * name inside the file decides, not the name of the file.
   *
   * One transaction, taken IMMEDIATE so the write lock is held BEFORE the stamp
   * is read. Read-then-write is not a claim: two processes that both looked at
   * an unstamped 0.4.1 file before either wrote both found it free, and
   * `INSERT OR REPLACE` let the second overwrite the first's name — so the two
   * scopes went on sharing one database and each recalled the other's private
   * facts, which is R1 again through the fix for R1 (GPT-6-Astra on the merged
   * result, 2026-09-19; `src/scope-claim-race.test.ts` runs two real
   * processes). The insert is conditional and the value is read back inside the
   * same transaction, so the claim the caller is told about is the one that is
   * in the file.
   */
  private claimScope(scope: string): void {
    const claim = this.db.transaction((): string => {
      this.db.prepare(`INSERT INTO memory_meta (key, value) VALUES ('scope', ?) ON CONFLICT(key) DO NOTHING`).run(scope);
      const row = this.db.prepare(`SELECT value FROM memory_meta WHERE key = 'scope'`).get() as { value?: string } | undefined;
      return row?.value ?? scope;
    });
    // The lock itself can be busy — two stores opening together is the ordinary
    // case (B1), and better-sqlite3's statement timeout does not cover it.
    const recorded = retryWhileBusy(() => claim.immediate());
    if (recorded !== scope) {
      this.db.close();
      throw new Error(`this database holds the scope ${JSON.stringify(recorded)}, not ${JSON.stringify(scope)}; refusing to open it — two projects must not share one memory file`);
    }
  }

  /** The scope recorded inside this file, if one is. */
  get scope(): string | null {
    const row = this.db.prepare(`SELECT value FROM memory_meta WHERE key = 'scope'`).get() as { value?: string } | undefined;
    return row?.value ?? null;
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
        const migration = MIGRATIONS[version]!;
        if (typeof migration === "function") migration(this.db);
        else for (const stmt of migration) runMigrationStep(this.db, stmt);
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
    // behind it (review 2026-09-01, §3). Since the audit table the same transaction also
    // carries the governance event, when one was asked for.
    return this.mutation((): MemoryNode => {
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
      return { ...node, nodeId, temporalAnchors, validFrom, validTo };
    });
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
    this.mutation((): void => {
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
        const existing = rowToNode(row);
        if (!mutableStatesEqual(mutableState(existing), mutableState(node))) {
          insertVersion(this.db, {
            versionId: randomUUID(),
            nodeId: node.nodeId,
            recordedAt: new Date().toISOString(),
            event: "restored",
            before: mutableState(existing),
            after: mutableState(node),
          });
        }
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
  }

  /** Verbatim edge insert for round-trip import (idempotent by edgeId). */
  async restoreEdge(input: MemoryEdge): Promise<void> {
    const edge = canonicalEdge(input);
    // One transaction, and an existing link is never replaced: identical is a
    // no-op, different is refused (edgeRestoreIsNoop).
    this.mutation(() => {
    const row = this.db.prepare(`SELECT * FROM memory_edges WHERE edge_id = ?`).get(edge.edgeId) as EdgeRow | undefined;
    if (edgeRestoreIsNoop(edge, row ? rowToEdge(row) : undefined)) return;
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
    });
  }

  async listNodes(): Promise<MemoryNode[]> {
    // No filters at all: this is enumeration (export, backup), not recall.
    const rows = this.db.prepare(`SELECT * FROM memory_nodes ORDER BY created_at ASC, node_id ASC`).all() as NodeRow[];
    return rows.map(rowToNode);
  }

  /**
   * The whole graph as one state — every node and every edge read inside one
   * transaction, so an export cannot pair the nodes of one instant with the
   * edges of another, even while another process writes (Astra R6, 2026-09-18).
   */
  async snapshot(): Promise<GraphSnapshot> {
    return this.db.transaction((): GraphSnapshot => ({
      nodes: (this.db.prepare(`SELECT * FROM memory_nodes ORDER BY created_at ASC, node_id ASC`).all() as NodeRow[]).map(rowToNode),
      edges: (this.db.prepare(`SELECT * FROM memory_edges ORDER BY edge_id ASC`).all() as EdgeRow[]).map(rowToEdge),
    }))();
  }

  async history(nodeId: string): Promise<NodeVersion[]> {
    return this.db.transaction((): NodeVersion[] => {
      const exists = this.db.prepare(`SELECT 1 FROM memory_nodes WHERE node_id = ?`).get(nodeId);
      return exists === undefined ? [] : readNodeVersions(this.db, nodeId);
    })();
  }

  async getNodeAsOf(nodeId: string, asOf: string): Promise<MemoryNode | undefined> {
    return this.db.transaction((): MemoryNode | undefined => {
      const row = this.db.prepare(`SELECT * FROM memory_nodes WHERE node_id = ?`).get(nodeId) as NodeRow | undefined;
      if (row === undefined) return undefined;
      return nodeAsOf(rowToNode(row), readNodeVersions(this.db, nodeId), asOf).node;
    })();
  }

  async snapshotAsOf(asOf: string): Promise<AsOfSnapshot> {
    return this.db.transaction((): AsOfSnapshot => {
      const nodes = (this.db.prepare(`SELECT * FROM memory_nodes ORDER BY created_at ASC, node_id ASC`).all() as NodeRow[]).map(rowToNode);
      const edges = (this.db.prepare(`SELECT * FROM memory_edges ORDER BY edge_id ASC`).all() as EdgeRow[]).map(rowToEdge);
      const byNode = new Map<string, NodeVersion[]>();
      for (const version of readAllVersions(this.db)) {
        const versions = byNode.get(version.nodeId) ?? [];
        versions.push(version);
        byNode.set(version.nodeId, versions);
      }
      return buildSnapshotAsOf(nodes, edges, byNode, asOf);
    })();
  }

  async historySnapshot(): Promise<GraphSnapshot & { versions: NodeVersion[] }> {
    return this.db.transaction(() => ({
      nodes: (this.db.prepare(`SELECT * FROM memory_nodes ORDER BY created_at ASC, node_id ASC`).all() as NodeRow[]).map(rowToNode),
      edges: (this.db.prepare(`SELECT * FROM memory_edges ORDER BY edge_id ASC`).all() as EdgeRow[]).map(rowToEdge),
      versions: readAllVersions(this.db),
    }))();
  }

  async restoreVersion(version: NodeVersion): Promise<void> {
    this.mutation(() => restoreSqliteVersion(this.db, version));
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
    type Row = NodeRow & { fts_rank?: number };
    const limited = limitN !== undefined && Number.isFinite(limitN);
    const pool = limited ? Math.max(limitN! * FTS_POOL_MULTIPLIER, FTS_POOL_MIN) : FTS_POOL_UNLIMITED;
    const also = (condition: string) => (where ? `${where} AND ${condition}` : `WHERE ${condition}`);
    // The pool's ORDER BY ends the same way the JS re-rank does, or a limited
    // read is a page of a DIFFERENT list.
    const read = (extra: string | null, limit: number): Row[] =>
      match !== null
        ? (this.db
            .prepare(
              `SELECT n.*, f.rank AS fts_rank FROM memory_nodes n
                 JOIN (SELECT rowid AS fts_id, rank FROM memory_fts WHERE content_text MATCH @match) f ON n.fts_rowid = f.fts_id
                 ${extra ? also(extra) : where} ORDER BY f.rank ASC, n.confidence_weight DESC, n.created_at DESC, n.node_id DESC
                 LIMIT ${limit}`,
            )
            .all(params) as Row[])
        : (this.db
            .prepare(`SELECT * FROM memory_nodes ${extra ? also(extra) : where} ${NO_QUERY_ORDER} LIMIT ${limit}`)
            .all(params) as Row[]);

    // Ranking happens in JS so decay can apply (decay.ts). With a query: BM25
    // (more negative = better), then effective confidence, then recency. With
    // none: effective confidence, then recency. The same last word as every
    // other read.
    const now = Date.now();
    const rank = (rows: Row[]) => {
      const out = rows.map((row) => ({ row, node: rowToNode(row), eff: 0 }));
      for (const n of out) n.eff = effectiveConfidence(n.node, now);
      out.sort((a, b) =>
        match !== null
          ? (a.row.fts_rank ?? 0) - (b.row.fts_rank ?? 0) || b.eff - a.eff || compareRecency(a.node, b.node)
          : b.eff - a.eff || compareRecency(a.node, b.node),
      );
      return out;
    };

    const first = read(null, pool);
    let nodes = rank(first);

    // A full pool may have left out a row that belongs on the page. SQL fills
    // the pool by STORED confidence, JS ranks by EFFECTIVE, and decay only
    // lowers — so a limited read used to be exact only when nothing decayed
    // (review 2026-09-14). Widen exactly as far as a row could still reach the
    // page, then re-rank; the page is then the first page of the unlimited read.
    if (limited && limitN! > 0 && first.length === pool && nodes.length >= limitN!) {
      const boundary = nodes[limitN! - 1]!;
      const last = first[first.length - 1]!;
      // A left-out row reaches the page only by beating the boundary row: a
      // higher effective confidence (which needs a STORED confidence above the
      // floor, since decay only lowers), or an equal one and a more recent
      // learning (created_at is learnedAt by construction). Read exactly those.
      // The first version read every row with stored >= floor, which on the
      // usual store — most facts at confidence 1 — was the whole table: 8 ms
      // became 325 ms at 100k facts (Fable re-review, 2026-09-15). A bare
      // "stored > floor" is not enough; the tie clause is what keeps it exact.
      params["floor"] = boundary.eff;
      params["boundaryCreated"] = boundary.row.created_at;
      params["boundaryId"] = boundary.row.node_id;
      // The whole order, id included: without the id, 100k facts sharing one
      // creation instant all "tied" the boundary and were all re-read (Astra).
      const beats = (col: (c: string) => string) =>
        `(${col("confidence_weight")} > @floor OR (${col("confidence_weight")} = @floor AND (${col("created_at")} > @boundaryCreated OR (${col("created_at")} = @boundaryCreated AND ${col("node_id")} >= @boundaryId))))`;
      // And read nothing when nothing can. The pool is in SQL order (rank, then
      // stored confidence, then recency), so every left-out row is no better
      // than the last pooled row on those keys, and its effective confidence is
      // no higher than its stored one. If the last pooled row could not beat the
      // boundary on (stored confidence, recency), no row after it can. On a
      // store where nothing has decayed — the usual one — this skips the second
      // read entirely; a store with real decay still gets it.
      const lastCouldBeat =
        last.confidence_weight > boundary.eff ||
        (last.confidence_weight === boundary.eff &&
          (last.created_at > boundary.row.created_at || (last.created_at === boundary.row.created_at && last.node_id >= boundary.row.node_id)));
      if (match === null) {
        if (lastCouldBeat) nodes = rank(read(beats((c) => c), -1));
      } else if ((last.fts_rank ?? 0) <= (boundary.row.fts_rank ?? 0) && lastCouldBeat) {
        // Relevance does not decay: better-ranked rows are all in the pool already,
        // and within the boundary's own rank the same confidence rule applies.
        params["boundaryRank"] = boundary.row.fts_rank ?? 0;
        nodes = rank(read(`(f.rank < @boundaryRank OR (f.rank = @boundaryRank AND ${beats((c) => `n.${c}`)}))`, -1));
      }
    }

    if (limited) nodes.length = Math.min(nodes.length, limitN!);
    return nodes.map((n) => n.node);
  }

  async updateNode(
    nodeId: string,
    // Reference the interface's patch type so it can never drift from it.
    input: Parameters<MemoryStore["updateNode"]>[1],
    anchorEvent: Parameters<MemoryStore["updateNode"]>[2] = "modified",
  ): Promise<MemoryNode> {
    assertPatchMutable(input);
    assertAnchorEvent(anchorEvent);
    const patch = canonicalPatch(input);
    // Read-modify-write under the write lock (IMMEDIATE): two processes that
    // both read the row and then each wrote their reconstruction used to lose
    // one change and its anchor.
    return this.mutation((): MemoryNode => {
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

      insertVersion(this.db, {
        versionId: randomUUID(),
        nodeId,
        recordedAt: now,
        event: anchorEvent,
        before: mutableState(existing),
        after: mutableState(updated),
      });

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
  }

  async deleteNode(nodeId: string): Promise<void> {
    // One transaction: a crash between the two deletes used to leave a readable
    // fact that keyword search could never find again.
    this.mutation(() => {
      const row = this.db
        .prepare(`SELECT fts_rowid FROM memory_nodes WHERE node_id = ?`)
        .get(nodeId) as Pick<NodeRow, "fts_rowid"> | undefined;
      if (row !== undefined) {
        this.db.prepare(`DELETE FROM memory_fts WHERE rowid = ?`).run(row.fts_rowid);
      }
      // ON DELETE CASCADE clears memory_edges and memory_embeddings.
      this.db.prepare(`DELETE FROM memory_nodes WHERE node_id = ?`).run(nodeId);
    });
  }

  // -------------------------------------------------------------------------
  // Edge operations
  // -------------------------------------------------------------------------

  async addEdge(edge: Omit<MemoryEdge, "edgeId" | "createdAt">): Promise<MemoryEdge> {
    assertEdge(edge);
    const edgeId = randomUUID();
    const createdAt = new Date().toISOString();

    return this.mutation((): MemoryEdge => {
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
    });
  }

  async getEdges(nodeId: string): Promise<MemoryEdge[]> {
    const rows = this.db
      .prepare(`SELECT * FROM memory_edges WHERE source_node_id = ? OR target_node_id = ?`)
      .all(nodeId, nodeId) as EdgeRow[];
    return rows.map(rowToEdge);
  }

  async deleteEdge(edgeId: string): Promise<void> {
    this.mutation(() => {
      this.db.prepare(`DELETE FROM memory_edges WHERE edge_id = ?`).run(edgeId);
    });
  }

  // -------------------------------------------------------------------------
  // Embedding operations — model-tagged, disposable vector cache
  // -------------------------------------------------------------------------

  async setEmbedding(embedding: Omit<MemoryEmbedding, "createdAt">): Promise<MemoryEmbedding> {
    const createdAt = new Date().toISOString();
    // Upsert on (node_id, model): re-embedding a node with the same model
    // replaces the vector; a different model coexists as its own row.
    return this.mutation((): MemoryEmbedding => {
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
    });
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
    this.mutation(() => {
      if (model !== undefined) {
        this.db
          .prepare(`DELETE FROM memory_embeddings WHERE node_id = ? AND model = ?`)
          .run(nodeId, model);
        return;
      }
      this.db.prepare(`DELETE FROM memory_embeddings WHERE node_id = ?`).run(nodeId);
    });
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /** Close the underlying database connection. Call in tests and on process exit. */
  close(): void {
    this.db.close();
  }
}
