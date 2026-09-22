import Database from "better-sqlite3";

import { assertVersion, versionsEqual } from "./history.js";
import type { NodeVersion } from "./types/memory.js";

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

export function insertVersion(db: Database.Database, version: NodeVersion): void {
  assertVersion(version);
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
  const node = db.prepare(`SELECT 1 FROM memory_nodes WHERE node_id = ?`).get(version.nodeId);
  if (node === undefined) throw new Error(`cannot restore version ${version.versionId}: node ${version.nodeId} does not exist`);
  insertVersion(db, version);
}

export function readNodeVersions(db: Database.Database, nodeId: string): NodeVersion[] {
  return (db.prepare(`SELECT * FROM node_versions WHERE node_id = ? ORDER BY seq ASC`).all(nodeId) as VersionRow[]).map(rowToVersion);
}

export function readAllVersions(db: Database.Database): NodeVersion[] {
  return (db.prepare(`SELECT * FROM node_versions ORDER BY seq ASC`).all() as VersionRow[]).map(rowToVersion);
}
