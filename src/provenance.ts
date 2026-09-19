/**
 * Source provenance — grounding a belief in the conversation that produced it.
 *
 * When the curator distills an AIInferred fact ("lives in Tokyo") from a turn,
 * it stashes the originating exchange under `contextualMetadata.sourceExchange`
 * so the fact is auditable: you can always answer "why does Al believe this?"
 * with "because on <date> you said <X> and Al replied <Y>." This is the trust
 * surface — a governed memory you can trace, not just query.
 *
 * Stored in `contextualMetadata` (not a new column) so it rides the existing
 * schema, export, and privacy tier automatically — the source exchange inherits
 * the node's own classification, so a Sealed fact's source is Sealed too.
 */

/** A single turn an inferred fact was distilled from. */
export interface SourceExchange {
  user: string;
  assistant: string;
  /** ISO 8601 — when the exchange happened. */
  at: string;
}

/** Cap stored turn text so one huge message can't bloat every derived fact. */
const MAX_TURN_CHARS = 2000;

const SOURCE_KEY = "sourceExchange";

/**
 * Build a `contextualMetadata` object carrying the source exchange, merged over
 * any base metadata (e.g. the `source: "auto-curated"` label and tags).
 */
export function buildSourceProvenance(
  exchange: { user: string; assistant: string },
  at: string,
  base: Record<string, unknown> = {},
): Record<string, unknown> {
  const source: SourceExchange = {
    user: exchange.user.slice(0, MAX_TURN_CHARS),
    assistant: exchange.assistant.slice(0, MAX_TURN_CHARS),
    at,
  };
  return { ...base, [SOURCE_KEY]: source };
}

/** Extract a typed source exchange from metadata, or undefined if absent/malformed. */
export function readSourceProvenance(
  metadata: Record<string, unknown>,
): SourceExchange | undefined {
  const raw = metadata[SOURCE_KEY];
  if (typeof raw !== "object" || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  if (
    typeof record["user"] !== "string" ||
    typeof record["assistant"] !== "string" ||
    typeof record["at"] !== "string"
  ) {
    return undefined;
  }
  return { user: record["user"], assistant: record["assistant"], at: record["at"] };
}

/**
 * Which assistant, app or agent wrote a fact — so memory shared across assistants
 * can say which one told you something, and a person can filter or undo one
 * source's work. Record only what the writer actually knows (founder, 2026-09-15):
 *
 * - `app` / `appVersion`: the client, as the MCP connection announced itself —
 *   reliable, the model cannot change it.
 * - `agent`, `channel`, `model`: set by a host that knows them (Al's own capture
 *   knows its model and channel).
 * - `modelClaimed`: a model name the model reported about itself — kept apart from
 *   `model` because nothing verifies it.
 * - `via`: the path the fact arrived by ("mcp", "api", …).
 *
 * Kept in contextualMetadata.origin for 0.4.x; a first-class, immutable field in the
 * spec and portable format is planned for 0.5.
 */
export interface Origin {
  app?: string;
  appVersion?: string;
  agent?: string;
  channel?: string;
  model?: string;
  modelClaimed?: string;
  via?: string;
}

const ORIGIN_FIELDS = ["app", "appVersion", "agent", "channel", "model", "modelClaimed", "via"] as const;

/** Only the fields the writer actually knew — or undefined when it knew none. */
export function knownOrigin(origin: Origin | undefined): Origin | undefined {
  const known = Object.fromEntries(Object.entries(origin ?? {}).filter(([, v]) => typeof v === "string" && v !== ""));
  return Object.keys(known).length === 0 ? undefined : (known as Origin);
}

/** `metadata` with `origin` added — omitted entirely when nothing is known. */
export function withOrigin(metadata: Record<string, unknown>, origin: Origin | undefined): Record<string, unknown> {
  const known = knownOrigin(origin);
  return known === undefined ? metadata : { ...metadata, origin: known };
}

/**
 * Read an origin back out of metadata — `origin` (who wrote the fact) or
 * `retiredBy` (who closed it). Returns null rather than `{}` so "nobody recorded
 * it" and "an assistant we know nothing about" stay different answers.
 *
 * Only the declared fields come back: metadata is JSON a host or an import may
 * have written, so an unknown key is not passed through to a caller that will
 * show it as a receipt.
 */
export function readOrigin(metadata: Record<string, unknown>, key = "origin"): Origin | null {
  const raw = metadata[key];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const field of ORIGIN_FIELDS) {
    const value = record[field];
    if (typeof value === "string" && value !== "") out[field] = value;
  }
  return Object.keys(out).length === 0 ? null : (out as Origin);
}

