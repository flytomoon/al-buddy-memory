import Database from "better-sqlite3";

import { assertVersion, assertVersionFitsNode, versionsEqual } from "./history.js";
import type { MemoryNode, NodeVersion } from "./types/memory.js";

export const MIGRATION_V8 = [
  `CREATE TABLE IF NOT EXISTS node_versions (
    seq         INTEGER PRIMARY KEY AUTOINCREMENT,
    version_id  TEXT NOT NULL UNIQUE,
    node_id     TEXT NOT NULL REFERENCES memory_nodes(node_id) ON DELETE CASCADE,
    recorded_at TEXT NOT NULL,
    event       TEXT NOT NULL,
    before_json TEXT NOT NULL,
    after_json  TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_versions_node ON node_versions (node_id, seq)`,
];

interface VersionRow {
  version_id: string;
  node_id: string;
  recorded_at: string;
  event: string;
  before_json: string;
  after_json: string;
}

function rowToVersion(row: VersionRow): NodeVersion {
  return {
    versionId: row.version_id,
    nodeId: row.node_id,
    recordedAt: row.recorded_at,
    event: row.event as NodeVersion["event"],
    before: JSON.parse(row.before_json) as NodeVersion["before"],
    after: JSON.parse(row.after_json) as NodeVersion["after"],
  };
}

/**
 * Write one version. NOT validated here, on purpose: the store builds these
 * images itself from the row it just read, and rows written before 0.4.0 can
 * hold values today's checks refuse (a word outside the vocabulary, a weight
 * above 1, an instant v5 could not parse and left as it was). Validating the
 * store's own before-image made every update to such a fact throw, so it could
 * no longer even be invalidated (release review 2026-09-21). Imports are
 * validated, in `restoreSqliteVersion`.
 */
export function insertVersion(db: Database.Database, version: NodeVersion): void {
  db.prepare(
    `INSERT INTO node_versions
       (version_id, node_id, recorded_at, event, before_json, after_json)
     VALUES (@versionId, @nodeId, @recordedAt, @event, @before, @after)`,
  ).run({
    versionId: version.versionId,
    nodeId: version.nodeId,
    recordedAt: version.recordedAt,
    event: version.event,
    before: JSON.stringify(version.before),
    after: JSON.stringify(version.after),
  });
}

export function restoreSqliteVersion(db: Database.Database, version: NodeVersion): void {
  assertVersion(version);
  const existing = db.prepare(`SELECT * FROM node_versions WHERE version_id = ?`).get(version.versionId) as VersionRow | undefined;
  if (existing !== undefined) {
    if (!versionsEqual(rowToVersion(existing), version)) throw new Error(`cannot restore version ${version.versionId}: that id already records a different change`);
    return;
  }
  const row = db.prepare(`SELECT temporal_anchors, valid_from FROM memory_nodes WHERE node_id = ?`).get(version.nodeId) as { temporal_anchors: string; valid_from: string } | undefined;
  if (row === undefined) throw new Error(`cannot restore version ${version.versionId}: node ${version.nodeId} does not exist`);
  // Only the anchor trail (and the fallback learnedAt reads) matter to the fit check.
  assertVersionFitsNode(version, { temporalAnchors: JSON.parse(row.temporal_anchors), validFrom: row.valid_from } as MemoryNode);
  // The six documented fields only (insertVersion writes nothing else).
  insertVersion(db, {
    versionId: version.versionId,
    nodeId: version.nodeId,
    recordedAt: version.recordedAt,
    event: version.event,
    before: version.before,
    after: version.after,
  });
}

export function readNodeVersions(db: Database.Database, nodeId: string): NodeVersion[] {
  return (db.prepare(`SELECT * FROM node_versions WHERE node_id = ? ORDER BY seq ASC`).all(nodeId) as VersionRow[]).map(rowToVersion);
}

export function readAllVersions(db: Database.Database): NodeVersion[] {
  return (db.prepare(`SELECT * FROM node_versions ORDER BY seq ASC`).all() as VersionRow[]).map(rowToVersion);
}
