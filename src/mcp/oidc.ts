/**
 * Sign-in by the company's own identity provider (Okta, Microsoft Entra,
 * Google Workspace, Keycloak — anything that issues OIDC/JWT bearer tokens),
 * for the HTTP server (http-server.ts).
 *
 * A token is accepted only when its signature checks against the issuer's
 * published keys (JWKS), its `iss` is the configured issuer, its `aud` holds
 * the configured audience, it carries an `exp` that has not passed (and any
 * `nbf` has), and it names an actor — plus a tenant, when a tenant claim is
 * configured. Anything else is refused, with no partial identity: it fails
 * closed. The checks are jose's; nothing here parses or verifies a JWT by hand.
 *
 * The configured claims become the actor's attributes, the names a policy's
 * `readBoundary` and hooks already read (`{ label: "team", in: { actor: "teams" } }`).
 * Nothing about any one provider or company is built in: which claim holds
 * groups, roles, a department or the tenant is configuration.
 */
import { createLocalJWKSet, createRemoteJWKSet, jwtVerify, type JSONWebKeySet, type JWTPayload, type JWTVerifyGetKey } from "jose";

/** What the server needs to know about the identity provider. */
export interface OidcOptions {
  /** The issuer exactly as its tokens' `iss` carries it, e.g. `https://login.microsoftonline.com/<tenant-id>/v2.0`. */
  issuer: string;
  /** What `aud` must hold: this API's identifier at the identity provider. Several: any one of them. */
  audience: string | readonly string[];
  /**
   * Claim name → actor attribute name, e.g. `{ groups: "teams", roles: "roles" }`.
   * A claim name is looked up as given first (namespaced claims such as
   * `https://example.com/roles` contain dots), then as a dotted path
   * (`realm_access.roles`). A string claim gives one value, an array its
   * string members; a claim that is absent or holds anything else gives the
   * actor no such attribute, and a boundary on it matches nothing. Two claims
   * mapped onto one attribute are merged.
   */
  claims?: Readonly<Record<string, string>> | undefined;
  /** The claim naming the tenant (e.g. `tid`). When set, a token without a non-empty string there is refused. */
  tenantClaim?: string | undefined;
  /** The claim naming the actor. Default `sub`. A token without a non-empty string there is refused. */
  actorClaim?: string | undefined;
  /** Where the issuer's keys are. Default: the `jwks_uri` of `<issuer>/.well-known/openid-configuration`. */
  jwksUri?: string | undefined;
  /** The issuer's keys, given directly: no fetching at all (air-gapped setups, tests). */
  jwks?: JSONWebKeySet | undefined;
  /** Signing algorithms accepted. Default: every asymmetric JWS algorithm; symmetric ones and `none` are never accepted. */
  algorithms?: readonly string[] | undefined;
  /** Leeway for clock skew on `exp` and `nbf`, in seconds, from 0 to 300. Default 30. */
  clockToleranceSeconds?: number | undefined;
}

/** Who a verified token says is asking. */
export interface OidcIdentity {
  /** The actor claim's value (`sub` by default): what policies and the audit trail see as `actor`. */
  actor: string;
  /** The tenant claim's value, when one is configured. */
  tenant?: string;
  /** The mapped claims, ready for `PolicyContext.attributes`. */
  attributes: Record<string, string | string[]>;
  /** `scope` (space-separated) or `scp`, as a list. */
  scopes: string[];
  /** The token's `exp`, in seconds since the epoch. */
  expiresAt: number;
}

/** A token was not accepted. `reason` is for the operator's log; the caller is told only that it was refused. */
export class OidcTokenRefused extends Error {
  constructor(public readonly reason: string) {
    super("token refused");
    this.name = "OidcTokenRefused";
  }
}

export const ASYMMETRIC_ALGORITHMS: readonly string[] = ["RS256", "RS384", "RS512", "PS256", "PS384", "PS512", "ES256", "ES384", "ES512", "EdDSA", "Ed25519"];
const DISCOVERY_TIMEOUT_MS = 5_000;
/** More skew than this is not skew: an unbounded leeway would accept every expired token. */
const MAX_CLOCK_TOLERANCE_SECONDS = 300;

/**
 * Whether the keys may be fetched from `url`. Whoever answers that fetch
 * decides which signatures verify, so it is https, or plain http to an
 * identity provider on this machine (development, tests). Security review
 * 2026-10: any http URL used to be fetched.
 */
function fetchable(url: URL): boolean {
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "[::1]" || /^127\.\d+\.\d+\.\d+$/.test(url.hostname));
}

function assertOptions(o: OidcOptions): void {
  const fail = (why: string): never => {
    throw new Error(`oidc: ${why}`);
  };
  try {
    new URL(o.issuer);
  } catch {
    fail("issuer must be the identity provider's issuer URL");
  }
  const audiences = typeof o.audience === "string" ? [o.audience] : o.audience;
  if (!Array.isArray(audiences) || audiences.length === 0 || audiences.some((a) => typeof a !== "string" || a === "")) fail("audience must be a non-empty string or list of them");
  for (const [claim, attribute] of Object.entries(o.claims ?? {})) {
    if (claim === "" || typeof attribute !== "string" || attribute === "") fail("claims maps claim names to attribute names; neither may be empty");
  }
  if (o.tenantClaim !== undefined && o.tenantClaim === "") fail("tenantClaim must not be empty");
  if (o.actorClaim !== undefined && o.actorClaim === "") fail("actorClaim must not be empty");
  if (o.algorithms !== undefined && (o.algorithms.length === 0 || o.algorithms.some((a) => !ASYMMETRIC_ALGORITHMS.includes(a)))) {
    fail(`algorithms must be asymmetric signing algorithms (${ASYMMETRIC_ALGORITHMS.join(", ")})`);
  }
  if (o.jwksUri !== undefined) {
    try {
      new URL(o.jwksUri);
    } catch {
      fail("jwksUri must be a URL");
    }
  }
  if (o.jwks === undefined) {
    const [name, from] = o.jwksUri !== undefined ? ["jwksUri", o.jwksUri] : ["issuer", o.issuer];
    if (!fetchable(new URL(from))) fail(`${name} must be an https URL: the signing keys are fetched from it (plain http only to this machine), or give jwks`);
  }
  const skew = o.clockToleranceSeconds;
  if (skew !== undefined && !(typeof skew === "number" && skew >= 0 && skew <= MAX_CLOCK_TOLERANCE_SECONDS)) {
    fail(`clockToleranceSeconds must be a number of seconds from 0 to ${MAX_CLOCK_TOLERANCE_SECONDS}`);
  }
}

/** A claim by its exact name, else by dotted path. */
function claim(payload: JWTPayload, name: string): unknown {
  if (Object.hasOwn(payload, name)) return payload[name];
  let at: unknown = payload;
  for (const part of name.split(".")) {
    if (typeof at !== "object" || at === null || Array.isArray(at) || !Object.hasOwn(at, part)) return undefined;
    at = (at as Record<string, unknown>)[part];
  }
  return at;
}

const nonEmpty = (v: unknown): v is string => typeof v === "string" && v !== "";

function attributesOf(payload: JWTPayload, map: Readonly<Record<string, string>>): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [name, attribute] of Object.entries(map)) {
    const raw = claim(payload, name);
    const values = typeof raw === "string" ? [raw] : Array.isArray(raw) ? raw.filter((v): v is string => typeof v === "string") : undefined;
    if (values === undefined) continue;
    const had = out[attribute];
    if (had === undefined) {
      out[attribute] = typeof raw === "string" ? raw : values;
    } else {
      const merged = [...new Set([...(typeof had === "string" ? [had] : had), ...values])];
      out[attribute] = merged;
    }
  }
  return out;
}

function scopesOf(payload: JWTPayload): string[] {
  const s = payload["scope"] ?? payload["scp"];
  if (typeof s === "string") return s.split(" ").filter(Boolean);
  return Array.isArray(s) ? s.filter((v): v is string => typeof v === "string") : [];
}

/**
 * The issuer's keys, found through its discovery document. The document must
 * name the configured issuer (OpenID Connect Discovery §4.3), or its keys are
 * not trusted. A failure is not cached: every token is refused until a later
 * attempt succeeds.
 */
function discoveredKeys(issuer: string): JWTVerifyGetKey {
  let keys: Promise<JWTVerifyGetKey> | undefined;
  const discover = async (): Promise<JWTVerifyGetKey> => {
    const url = `${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`;
    const res = await fetch(url, { signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`discovery answered ${res.status}`);
    const doc = (await res.json()) as { issuer?: unknown; jwks_uri?: unknown };
    if (doc.issuer !== issuer) throw new Error("the discovery document names another issuer");
    if (typeof doc.jwks_uri !== "string") throw new Error("the discovery document has no jwks_uri");
    const uri = new URL(doc.jwks_uri);
    if (!fetchable(uri)) throw new Error("the discovery document's jwks_uri is not https");
    return createRemoteJWKSet(uri);
  };
  return async (header, token) => {
    keys ??= discover().catch((err: unknown) => {
      keys = undefined;
      throw err;
    });
    return (await keys)(header, token);
  };
}

/** Checks bearer tokens against one issuer; build it once and share it, so the issuer's keys are fetched once. */
export function oidcVerifier(options: OidcOptions): { verify(token: string): Promise<OidcIdentity> } {
  assertOptions(options);
  const keys: JWTVerifyGetKey = options.jwks
    ? createLocalJWKSet(options.jwks)
    : options.jwksUri
      ? createRemoteJWKSet(new URL(options.jwksUri))
      : discoveredKeys(options.issuer);
  const audience = typeof options.audience === "string" ? options.audience : [...options.audience];
  const algorithms = [...(options.algorithms ?? ASYMMETRIC_ALGORITHMS)];
  const clockTolerance = options.clockToleranceSeconds ?? 30;
  const actorClaim = options.actorClaim ?? "sub";
  const map = options.claims ?? {};

  return {
    async verify(token: string): Promise<OidcIdentity> {
      let payload: JWTPayload;
      try {
        ({ payload } = await jwtVerify(token, keys, { issuer: options.issuer, audience, algorithms, clockTolerance, requiredClaims: ["iss", "aud", "exp"] }));
      } catch (err) {
        throw new OidcTokenRefused(err instanceof Error ? err.message : String(err));
      }
      const actor = claim(payload, actorClaim);
      if (!nonEmpty(actor)) throw new OidcTokenRefused(`no ${actorClaim} claim naming the actor`);
      let tenant: string | undefined;
      if (options.tenantClaim !== undefined) {
        const t = claim(payload, options.tenantClaim);
        if (!nonEmpty(t)) throw new OidcTokenRefused(`no ${options.tenantClaim} claim naming the tenant`);
        tenant = t;
      }
      return {
        actor,
        ...(tenant !== undefined && { tenant }),
        attributes: attributesOf(payload, map),
        scopes: scopesOf(payload),
        expiresAt: payload.exp!,
      };
    },
  };
}
