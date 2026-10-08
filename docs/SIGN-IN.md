# Sign-in with your identity provider

The HTTP server (`al-buddy-memory/http`) can accept bearer tokens from your organisation's own
identity provider instead of the owner's passphrase. Each request's token says who is asking;
its claims become the actor attributes that a policy's [`readBoundary`](policies/boundaries.md)
and hooks already read; one claim can name the tenant, which picks the store. The server runs no
sign-in of its own: no passphrase page, no client registration, no tokens it issues.

```ts
import { startHttpConnector } from "al-buddy-memory/http";
import { PostgresMemoryStore, govern, storeAudit } from "al-buddy-memory";
import { boundaries } from "./boundaries.js"; // your policy, e.g. docs/policies/boundaries.ts

// The tenants this server serves. The tenant claim says which one a token is for;
// it does not limit who can sign in (see "What to know").
const TENANTS = new Set(["<tenant-id>"]);
const stores = new Map<string, Promise<PostgresMemoryStore>>();
const storeFor = (tenantId: string) => {
  if (!TENANTS.has(tenantId)) throw new Error("not a tenant this server serves");
  if (!stores.has(tenantId)) {
    const s = new PostgresMemoryStore({ connectionString: process.env.DATABASE_URL!, tenantId });
    stores.set(tenantId, s.initialize().then(() => s));
  }
  return stores.get(tenantId)!;
};

await startHttpConnector({
  publicUrl: "https://memory.example.com",
  port: 8787,
  oidc: {
    issuer: "https://login.microsoftonline.com/<tenant-id>/v2.0",
    audience: "<api-application-id>",
    claims: { groups: "teams", roles: "roles" }, // claim name → attribute name
    tenantClaim: "tid",
    actorClaim: "oid",
  },
  deps: async (who) => {
    const inner = await storeFor(who.tenant!);
    return {
      store: govern(inner, {
        policies: [boundaries],
        context: () => ({ actor: who.actor, attributes: who.attributes }),
        audit: storeAudit(inner),
      }),
    };
  },
});
```

| Option | Means |
|---|---|
| `issuer` | the `iss` your tokens carry, exactly |
| `audience` | what `aud` must hold: this API's identifier at your provider (a list: any one of them) |
| `claims` | claim name → attribute name. A dotted name is read as written first (`https://example.com/roles`), then as a path (`realm_access.roles`). Two claims may feed one attribute; their values are merged. |
| `tenantClaim` | the claim naming the tenant. When set, a token without it is refused. |
| `actorClaim` | the claim naming the actor (default `sub`); it is who the audit trail records |
| `jwksUri` / `jwks` | where the signing keys are. Default: the `jwks_uri` in `<issuer>/.well-known/openid-configuration`, which must name the same issuer. `jwks` takes the key set itself and fetches nothing. Keys are fetched over https only (plain http only from this machine, for development): whoever answers that fetch decides which tokens verify. |
| `algorithms` | default every asymmetric JWS algorithm. `HS*` and `none` are never accepted. |
| `clockToleranceSeconds` | skew allowed on `exp` and `nbf`, 0 to 300 (default 30) |

## It fails closed

A token is refused, with a 401 and a pointer to the issuer, and never reaches `deps` when: the
signature does not check against the issuer's keys; `iss` or `aud` is wrong or missing; `exp`
is missing or past; `nbf` is in the future; the algorithm is not an allowed one; or the actor or
tenant claim is missing or not a non-empty string. Verification is
[jose](https://github.com/panva/jose)'s; nothing here checks a JWT by hand. A claim that is
missing or is not a string or a list of strings gives no attribute, and a boundary that reads an
attribute the actor does not have matches nothing. While discovery fails, every token is
refused; it is tried again on the next request.

## The claim map, by provider

These are starting points. What each provider puts in a token depends on how the application is
registered there, so decode one real token and map what it carries. The attribute names
(`teams`, `roles`, `department`) are yours: use the words your policy reads.

**Okta** (a custom authorization server). `groups` and `department` are claims you add on the
authorization server (*Security → API → Authorization Servers → Claims*), for example a Groups
claim with a filter, and `user.department` for the department. `uid` is the user's stable id;
`sub` is their login.

```ts
oidc: {
  issuer: "https://<your-okta-domain>/oauth2/default",
  audience: "api://default",
  actorClaim: "uid",
  claims: { groups: "teams", department: "department" },
}
```

**Microsoft Entra ID** (v2.0 access tokens for your API: set `requestedAccessTokenVersion` to 2
in its manifest). `aud` is the API's application (client) ID. `tid` is the directory, `oid` the
user across applications (`sub` differs per application). `groups` holds group object IDs when
the groups claim is turned on under *Token configuration*; `roles` holds the app roles the user
is assigned. Past 200 groups Entra leaves `groups` out and points at Microsoft Graph instead;
this server does not call Graph, so such a user has no `teams` attribute. Use app roles, or emit
only the groups assigned to the application. `department` is not in a token unless you add it
(optional claims or a claims-mapping policy).

```ts
oidc: {
  issuer: "https://login.microsoftonline.com/<tenant-id>/v2.0",
  audience: "<api-application-id>",
  actorClaim: "oid",
  tenantClaim: "tid",
  claims: { groups: "teams", roles: "roles" },
}
```

**Google Workspace**. Google's access tokens are not JWTs, so use its ID tokens, whose `aud` is
your OAuth client ID. `hd` is the Workspace domain. Google tokens carry no groups or department:
look them up in your directory inside `deps` and add them to the attributes there, or write the
boundary over what the token does carry.

```ts
oidc: {
  issuer: "https://accounts.google.com",
  audience: "<oauth-client-id>.apps.googleusercontent.com",
  tenantClaim: "hd",
  claims: { hd: "domain", email: "email" },
}
```

## What to know

- **One issuer per server.** A multi-tenant Entra application sees a different issuer per
  directory; run a server (or a verifier) per issuer you accept.
- **The tenant claim picks a store; it does not choose who may sign in.** Every account the
  issuer will sign a token for, for your audience, gets in, with its own tenant value. Google's
  issuer signs for every Workspace domain (and `hd` is any of them), so a `deps` that opens a
  store for whatever tenant arrives gives any organisation its own memory on your database.
  Refuse the tenants you do not serve in `deps`, as the example does.
- **Name the actor by an identifier the person cannot change.** `sub`, Entra's `oid` and
  Okta's `uid` are assigned by the provider; `email`, `preferred_username` and `upn` can be
  edited, reused or unverified at some providers, and whoever holds the name holds that actor's
  facts and audit identity.
- **Attributes come only from the token**, unless `deps` adds more. Whoever can change a claim at
  your provider can change what that person sees here.
- **The audit trail records `actorClaim`'s value** as the actor, and the connecting app's name as
  the origin, as for the owner's server.
- The owner's passphrase server is unchanged, and the `al-buddy-memory-http` command still runs
  it. A server signed in by your provider is started from your own code, because it needs your
  policy and your stores.
