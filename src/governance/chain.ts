/**
 * The hash chain itself, with no opinion about where the records are kept.
 *
 * Two things carry an audit trail: a file of JSON lines (`ChainedAudit`) and a
 * table inside the database (`audit_events`). They must hash a record the same
 * way or one form's chain could not be checked by the other's verifier, and a
 * store that moved from one to the other would look tampered with. So the
 * canonical form, the digest and the per-record check live here once.
 *
 * Synchronous on purpose: the table's append runs inside a SQLite transaction,
 * and better-sqlite3 transactions cannot await.
 */
import { createHash, createHmac } from "node:crypto";

/** The `prev` of the first record in any chain. */
export const GENESIS = "0".repeat(64);

/** What a record will hold, with keys sorted so the hash does not depend on key order. */
export function canonical(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, (v as Record<string, unknown>)[k]]))
      : v,
  );
}

/** The hash of one record: its predecessor's hash and its own content. */
export function chainDigest(prev: string, event: unknown, key: string | undefined): string {
  const body = `${prev}\n${canonical(event)}`;
  return (key === undefined ? createHash("sha256") : createHmac("sha256", key)).update(body).digest("hex");
}

/**
 * What a broken link is called, in the words of the form it was found in. A
 * person reading `verify-audit` gets a line number for a file and an event
 * number for a table, and the sentence has to read as English either way.
 */
export interface ChainLabels {
  at(position: number): string;
  /** "the line before it" / "the event before it" */
  before: string;
  /** "a line was removed, inserted or reordered" */
  removed: string;
}

export const LINE_LABELS: ChainLabels = {
  at: (n) => `line ${n}`,
  before: "the line before it",
  removed: "a line was removed, inserted or reordered",
};

export const EVENT_LABELS: ChainLabels = {
  at: (n) => `event ${n}`,
  before: "the event before it",
  removed: "an event was removed, inserted or reordered",
};

/** A parsed record, before it has been checked. */
export interface ChainRecord {
  prev?: unknown;
  hash?: unknown;
  event?: unknown;
}

/**
 * Check one record against the hash that should precede it. Returns the reason
 * it is broken, or `null` when it is sound.
 *
 * The hash covers `prev` and `event` and nothing else, so a record carrying any
 * other field is refused rather than silently leaving that field unprotected.
 */
export function linkFault(
  record: ChainRecord,
  expectedPrev: string,
  key: string | undefined,
  position: number,
  labels: ChainLabels,
): string | null {
  const at = labels.at(position);
  if (typeof record.prev !== "string" || typeof record.hash !== "string" || record.event === undefined) {
    return `${at} is not a chained audit record`;
  }
  const extra = Object.keys(record).filter((k) => k !== "prev" && k !== "hash" && k !== "event");
  if (extra.length > 0) return `${at} has fields outside the chain (${extra.join(", ")})`;
  if (record.prev !== expectedPrev) return `${at} does not follow ${labels.before}: ${labels.removed}`;
  if (chainDigest(record.prev, record.event, key) !== record.hash) {
    return `${at} was edited: its hash does not match its content${
      key === undefined ? " (or the log was chained with a key, and none was given)" : " under this key (or the key is wrong)"
    }`;
  }
  return null;
}
