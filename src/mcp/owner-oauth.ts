/**
 * OAuth for a memory served to ONE owner over the web — the sign-in a remote
 * MCP connector in Claude or ChatGPT walks through (OAuth 2.1, PKCE S256,
 * dynamic client registration; the SDK's handlers do the protocol, this is the
 * provider behind them).
 *
 * The owner proves who they are with a passphrase on the consent page, once
 * per app; the app then holds a refresh token. Nothing here is multi-user: a
 * hosted, per-user memory is a different product with a real identity
 * provider in front of it.
 *
 * What is kept, in one 0600 JSON file: registered clients, and SHA-256 hashes
 * of codes and tokens — never a token itself, so a copied state file signs
 * nobody in. The passphrase is kept only as a scrypt hash. Wrong passphrases
 * lock the consent page for a while — for the app that sent them, and for
 * every app once there are too many in all — so a stranger guessing through
 * one app does not lock the owner's own app out (security review 2026-10-08,
 * M3). Nothing else is rate-limited here (the SDK's handlers rate-limit their
 * own endpoints).
 */
import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { Response } from "express";

import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import { InvalidClientMetadataError, InvalidGrantError, InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { AuthorizationParams, OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthClientInformationFull, OAuthTokenRevocationRequest, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";

export const ACCESS_TTL_S = 60 * 60;
export const REFRESH_TTL_S = 90 * 24 * 60 * 60;
const CODE_TTL_S = 5 * 60;
const PENDING_TTL_S = 10 * 60;
/** Wrong passphrases from one app before that app is locked out. */
const LOCK_CLIENT_AFTER = 5;
/** Wrong passphrases from all apps together, within LOCK_S, before every app is locked out. */
const LOCK_ALL_AFTER = 20;
const LOCK_S = 15 * 60;

interface Grant { clientId: string; scopes: string[]; resource?: string; expiresAt: number }
interface CodeGrant extends Grant { challenge: string; redirectUri: string }
interface PendingConsent { clientId: string; params: { state?: string; scopes?: string[]; codeChallenge: string; redirectUri: string; resource?: string }; expiresAt: number }
/** One app's wrong passphrases; forgotten LOCK_S after the last one (or after its lock ends). */
interface ClientFailures { count: number; lockedUntil: number; expiresAt: number }

interface Failures {
  byClient: Record<string, ClientFailures>;
  /** When each recent wrong passphrase came, from any app; only the last LOCK_S are kept. */
  recent: number[];
  /** Every app locked out until then. */
  lockedUntil: number;
}

interface OAuthState {
  clients: Record<string, OAuthClientInformationFull>;
  codes: Record<string, CodeGrant>;
  access: Record<string, Grant>;
  refresh: Record<string, Grant>;
  pending: Record<string, PendingConsent>;
  failures: Failures;
}

const noFailures = (): Failures => ({ byClient: {}, recent: [], lockedUntil: 0 });
const empty = (): OAuthState => ({ clients: {}, codes: {}, access: {}, refresh: {}, pending: {}, failures: noFailures() });
const hash = (s: string): string => createHash("sha256").update(s).digest("hex");
const token = (): string => randomBytes(32).toString("base64url");

/** "scrypt$<salt>$<hash>" — what the passphrase file holds. */
export function hashPassphrase(passphrase: string, salt: Buffer = randomBytes(16)): string {
  return `scrypt$${salt.toString("base64url")}$${scryptSync(passphrase, salt, 32).toString("base64url")}`;
}

export function checkPassphrase(passphrase: string, stored: string): boolean {
  const [kind, salt, want] = stored.trim().split("$");
  if (kind !== "scrypt" || !salt || !want) return false;
  const got = scryptSync(passphrase, Buffer.from(salt, "base64url"), 32);
  const expected = Buffer.from(want, "base64url");
  return got.length === expected.length && timingSafeEqual(got, expected);
}

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
/** An app's self-chosen name, safe for one log line: no control characters, not too long. */
const logName = (s: string): string => JSON.stringify(s.replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, " ").slice(0, 80));
const iso = (t: number): string => new Date(t * 1000).toISOString();

export interface OwnerOAuthOptions {
  /** Where clients and token hashes live (created 0600). */
  statePath: string;
  /** The scrypt hash from hashPassphrase — never the passphrase itself. */
  passphraseHash: string;
  /** Path the consent form posts to, mounted by the HTTP server. */
  consentPath?: string;
  /**
   * Origins an app may send the sign-in code back to. Registration with any other redirect is
   * refused, and the consent page names the destination — so a page posing as "Claude" cannot
   * collect a code for itself (security review 2026-10-08, H1). Loopback (localhost, 127.0.0.1,
   * [::1], any port) is always allowed: a desktop app's callback on this machine.
   */
  allowedRedirectOrigins?: readonly string[];
  /** The connector log: one line whenever wrong passphrases lock the consent page. */
  log?: (line: string) => void;
  now?: () => number;
}

/** The assistants this connector is for: Claude (web and app) and ChatGPT. */
export const DEFAULT_REDIRECT_ORIGINS: readonly string[] = ["https://claude.ai", "https://claude.com", "https://chatgpt.com", "https://chat.openai.com"];

/** Whether `uri` may receive a sign-in code: an allowed origin, or this machine. */
export function redirectAllowed(uri: string, allowed: readonly string[] = DEFAULT_REDIRECT_ORIGINS): boolean {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)) return true;
  return u.protocol === "https:" && allowed.includes(u.origin);
}

export class OwnerOAuthProvider implements OAuthServerProvider {
  readonly consentPath: string;
  private readonly allowedOrigins: readonly string[];
  private readonly now: () => number;

  constructor(private readonly opts: OwnerOAuthOptions) {
    this.consentPath = opts.consentPath ?? "/consent";
    this.allowedOrigins = opts.allowedRedirectOrigins ?? DEFAULT_REDIRECT_ORIGINS;
    this.now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  }

  private load(): OAuthState {
    let s: OAuthState;
    try {
      s = { ...empty(), ...(JSON.parse(readFileSync(this.opts.statePath, "utf8")) as Partial<OAuthState>) };
    } catch {
      return empty();
    }
    // A file from before per-app locks held one { count, lockedUntil }: keep its lock, as a lock on every app.
    const f = s.failures as Partial<Failures> | undefined;
    s.failures = { byClient: f?.byClient ?? {}, recent: Array.isArray(f?.recent) ? f.recent : [], lockedUntil: f?.lockedUntil ?? 0 };
    return s;
  }

  private save(s: OAuthState): void {
    const t = this.now();
    // Expired entries go on every write, so the file never grows without bound.
    for (const bag of [s.codes, s.access, s.refresh, s.pending, s.failures.byClient] as Record<string, { expiresAt: number }>[]) {
      for (const [k, v] of Object.entries(bag)) if (v.expiresAt <= t) delete bag[k];
    }
    s.failures.recent = s.failures.recent.filter((at) => at > t - LOCK_S);
    mkdirSync(dirname(this.opts.statePath), { recursive: true, mode: 0o700 });
    const tmp = `${this.opts.statePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(s, null, 2), { mode: 0o600 });
    renameSync(tmp, this.opts.statePath);
    if (existsSync(this.opts.statePath)) chmodSync(this.opts.statePath, 0o600);
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: (id: string) => this.load().clients[id],
      registerClient: (client: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">) => {
        const bad = (client.redirect_uris ?? []).map(String).filter((u) => !redirectAllowed(u, this.allowedOrigins));
        if (bad.length > 0) throw new InvalidClientMetadataError(`redirect not allowed for this connector: ${bad[0]} (allowed: ${this.allowedOrigins.join(", ")}, or this machine)`);
        const s = this.load();
        const full: OAuthClientInformationFull = { ...client, client_id: randomBytes(16).toString("hex"), client_id_issued_at: this.now() };
        s.clients[full.client_id] = full;
        this.save(s);
        return full;
      },
    };
  }

  /** Step 1: show the owner a consent page; the code is only issued after the passphrase. */
  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    // A client registered before the allowlist existed is held to it here too.
    if (!redirectAllowed(params.redirectUri, this.allowedOrigins)) {
      res.status(400).type("html").send(this.consentPage("", client.client_name ?? "An app", "This app asked to send your sign-in somewhere this connector does not allow.", ""));
      return;
    }
    const s = this.load();
    const id = token();
    s.pending[id] = {
      clientId: client.client_id,
      params: {
        codeChallenge: params.codeChallenge,
        redirectUri: params.redirectUri,
        ...(params.state !== undefined && { state: params.state }),
        ...(params.scopes && { scopes: params.scopes }),
        ...(params.resource && { resource: params.resource.href }),
      },
      expiresAt: this.now() + PENDING_TTL_S,
    };
    this.save(s);
    res.status(200).type("html").send(this.consentPage(id, client.client_name ?? "An app", "", params.redirectUri));
  }

  consentPage(pendingId: string, appName: string, error: string, redirectUri = ""): string {
    let dest = "";
    try {
      dest = redirectUri ? new URL(redirectUri).host : "";
    } catch {
      dest = "";
    }
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect your memory</title><style>
body{font:16px -apple-system,system-ui,sans-serif;margin:0;padding:24px;background:#f6f7f9;color:#1d2733}
main{max-width:420px;margin:8vh auto;background:#fff;border-radius:14px;padding:24px;box-shadow:0 2px 12px #0001}
h1{font-size:20px;margin:0 0 8px}p{color:#5b6878;margin:0 0 16px}input,button{width:100%;box-sizing:border-box;font-size:16px;padding:12px;border-radius:10px}
input{border:1px solid #cfd6de;margin-bottom:12px}button{border:0;background:#0f2a44;color:#fff;font-weight:600}.err{color:#b4432e}
@media (prefers-color-scheme:dark){body{background:#101418;color:#e6e9ee}main{background:#1a2027}input{background:#101418;color:#e6e9ee;border-color:#334}}
</style></head><body><main><h1>Connect ${esc(appName)} to your memory</h1>
<p>${esc(appName)} will be able to read and add to your al-buddy-memory. Every change it makes is recorded in the audit trail under its name.</p>
${dest ? `<p>Access goes to <strong>${esc(dest)}</strong>. Only allow it if that is where you started.</p>` : ""}
${error ? `<p class="err">${esc(error)}</p>` : ""}
<form method="post" action="${esc(this.consentPath)}"><input type="hidden" name="pending" value="${esc(pendingId)}">
<input type="password" name="passphrase" autocomplete="current-password" placeholder="Passphrase" required autofocus>
<button type="submit">Allow</button></form></main></body></html>`;
  }

  /**
   * Step 2, the consent form's POST: right passphrase → a one-time code on the
   * app's redirect URI; wrong → the page again. Five misses from one app lock
   * that app out; twenty from all apps within the lock time lock out every app
   * (so registering fresh apps does not buy more guesses). A lock is logged.
   */
  consent(pendingId: string, passphrase: string): { redirect: string } | { page: string; status: number } {
    const s = this.load();
    const t = this.now();
    const pending = s.pending[pendingId];
    if (!pending || pending.expiresAt <= t) return { page: this.consentPage("", "This app", "This sign-in expired. Start again from the app."), status: 400 };
    const appName = s.clients[pending.clientId]?.client_name ?? "An app";
    const mine = s.failures.byClient[pending.clientId];
    const lockedUntil = Math.max(s.failures.lockedUntil, mine?.lockedUntil ?? 0);
    if (lockedUntil > t) {
      const minutes = Math.ceil((lockedUntil - t) / 60);
      const who = s.failures.lockedUntil > t ? "" : " from this app";
      return { page: this.consentPage(pendingId, appName, `Too many wrong passphrases${who}. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`, pending.params.redirectUri), status: 429 };
    }
    if (!checkPassphrase(passphrase, this.opts.passphraseHash)) {
      const log = this.opts.log ?? (() => undefined);
      const name = `${logName(appName)} (client ${pending.clientId.slice(0, 8)})`;
      const c = mine ?? { count: 0, lockedUntil: 0, expiresAt: 0 };
      c.count += 1;
      c.expiresAt = t + LOCK_S;
      if (c.count >= LOCK_CLIENT_AFTER) {
        c.count = 0;
        c.lockedUntil = t + LOCK_S;
        log(`connector: consent locked for ${name} until ${iso(c.lockedUntil)}: ${LOCK_CLIENT_AFTER} wrong passphrases from it`);
      }
      s.failures.byClient[pending.clientId] = c;
      s.failures.recent = [...s.failures.recent.filter((at) => at > t - LOCK_S), t];
      if (s.failures.recent.length >= LOCK_ALL_AFTER) {
        s.failures.recent = [];
        s.failures.lockedUntil = t + LOCK_S;
        log(`connector: consent locked for every app until ${iso(s.failures.lockedUntil)}: ${LOCK_ALL_AFTER} wrong passphrases in ${LOCK_S / 60} minutes, the last from ${name}`);
      }
      this.save(s);
      return { page: this.consentPage(pendingId, appName, "That passphrase is not right.", pending.params.redirectUri), status: 401 };
    }
    delete s.failures.byClient[pending.clientId];
    delete s.pending[pendingId];
    const code = token();
    s.codes[hash(code)] = {
      clientId: pending.clientId,
      challenge: pending.params.codeChallenge,
      redirectUri: pending.params.redirectUri,
      scopes: pending.params.scopes ?? [],
      ...(pending.params.resource && { resource: pending.params.resource }),
      expiresAt: t + CODE_TTL_S,
    };
    this.save(s);
    const url = new URL(pending.params.redirectUri);
    url.searchParams.set("code", code);
    if (pending.params.state !== undefined) url.searchParams.set("state", pending.params.state);
    return { redirect: url.href };
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string): Promise<string> {
    const g = this.load().codes[hash(code)];
    if (!g || g.clientId !== client.client_id || g.expiresAt <= this.now()) throw new InvalidGrantError("invalid authorization code");
    return g.challenge;
  }

  private issue(s: OAuthState, clientId: string, scopes: string[], resource: string | undefined): OAuthTokens {
    const access = token();
    const refresh = token();
    const t = this.now();
    const base = { clientId, scopes, ...(resource && { resource }) };
    s.access[hash(access)] = { ...base, expiresAt: t + ACCESS_TTL_S };
    s.refresh[hash(refresh)] = { ...base, expiresAt: t + REFRESH_TTL_S };
    return { access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL_S, refresh_token: refresh, ...(scopes.length && { scope: scopes.join(" ") }) };
  }

  async exchangeAuthorizationCode(client: OAuthClientInformationFull, code: string, _verifier?: string, redirectUri?: string): Promise<OAuthTokens> {
    const s = this.load();
    const key = hash(code);
    const g = s.codes[key];
    // One use only, whatever happens next.
    delete s.codes[key];
    if (!g || g.clientId !== client.client_id || g.expiresAt <= this.now() || (redirectUri !== undefined && redirectUri !== g.redirectUri)) {
      this.save(s);
      throw new InvalidGrantError("invalid authorization code");
    }
    const tokens = this.issue(s, g.clientId, g.scopes, g.resource);
    this.save(s);
    return tokens;
  }

  /** Refresh tokens rotate: the old one stops working the moment the new pair is issued. */
  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string): Promise<OAuthTokens> {
    const s = this.load();
    const key = hash(refreshToken);
    const g = s.refresh[key];
    delete s.refresh[key];
    if (!g || g.clientId !== client.client_id || g.expiresAt <= this.now()) {
      this.save(s);
      throw new InvalidGrantError("invalid refresh token");
    }
    const tokens = this.issue(s, g.clientId, g.scopes, g.resource);
    this.save(s);
    return tokens;
  }

  async verifyAccessToken(accessToken: string): Promise<AuthInfo> {
    const g = this.load().access[hash(accessToken)];
    if (!g || g.expiresAt <= this.now()) throw new InvalidTokenError("invalid or expired token");
    return { token: accessToken, clientId: g.clientId, scopes: g.scopes, expiresAt: g.expiresAt, ...(g.resource && { resource: new URL(g.resource) }) };
  }

  async revokeToken(_client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    const s = this.load();
    const key = hash(request.token);
    delete s.access[key];
    delete s.refresh[key];
    this.save(s);
  }
}
