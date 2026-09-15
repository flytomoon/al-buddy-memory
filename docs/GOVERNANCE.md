# Governance: enforcing the vocabulary

The store ships the words — `privacyClassification` (Public / Private / Sensitive /
Sealed), `retentionTier`, `provenance` on every fact and relation. `govern()` is what
enforces them.

```ts
import { SqliteMemoryStore, govern, personalDefaults, JsonlAudit } from "al-buddy-memory";

const store = govern(new SqliteMemoryStore("brain.db"), {
  policies: [personalDefaults({ owner: "chris" })],
  context: () => ({ actor: currentActor() }),      // who is acting right now
  audit: new JsonlAudit("~/.al-buddy-memory/audit.jsonl"),
});
```

A policy is a plain object with up to five hooks:

| Hook | Runs | Can |
|---|---|---|
| `beforeWrite(node, ctx)` | before a fact is stored, and on import (`restoreNode`) | transform it (classify, tag) or refuse it |
| `beforeUpdate(existing, patch, ctx)` | before a change or invalidation, and when an import overwrites a fact | refuse it |
| `beforeRead(node, ctx)` | on the way out of `getNode`, `searchNodes`, `listNodes`, and for the endpoints of `getEdges` and the facts behind embeddings | hide it (`null`) or redact it |
| `beforeExport(node, ctx)` | when an `exportView` is being exported | allow or refuse |
| `beforeErase(subject, ctx)` | before `deleteNode` / `deleteEdge` | return `true` to allow, throw to refuse, return nothing to abstain; erasure needs one allow and no refusal |

`ctx` carries `actor`, optional `audience`, `purpose` (write / recall / invalidate / export /
import / erase) and `now`. Policies compose in order. Refusals throw `PolicyDenied` with the
policy's name and reason. When an audit sink is supplied, every allow, hide and refusal lands
in it as an append-only event, written after the store call succeeds; embedding calls are
not audited.

### A log you can check

`JsonlAudit` appends events; `ChainedAudit` also chains them. Each line carries the hash of
the line before and of its own event (HMAC-SHA256 when you pass a `key`), so
`verifyAuditChain(path, { key })` — or `al-buddy-memory verify-audit <file>` with the key in
`AL_BUDDY_MEMORY_AUDIT_KEY` — names the first line that was edited, removed, inserted or
reordered. Two limits, stated rather than implied: a file cannot prove its tail was not cut
off, and whoever holds the key can rewrite the whole chain. Both are caught by anchoring:
publish `await audit.head()` somewhere the log's owner does not control (a git commit, a
transparency log) and verify with `{ head }`. One writer per file.

A fact the actor cannot read is "not found" to their updates, erasures, links and embedding
calls, failing exactly as a missing fact does. Two edges of that rule, stated so nobody has to
find them: importing over a hidden fact is refused with `PolicyDenied` (so an actor who can
import and holds a candidate id learns that it exists), and `deleteEdge` is judged by the
erase policies alone, because an edge id carries no endpoints to check.

## The three samples

- **personalDefaults({ owner })** — the owner sees everything; anything that looks like a
  secret (API tokens, card numbers, "password: …", private keys) is written as Sensitive;
  Sensitive and Sealed facts never reach another audience and never leave in an export
  unless the owner is the one exporting.
- **guardianMode({ guardians })** — only a guardian may write, change or invalidate a
  `GuardianAdded` fact. Everyone may read them; that is what they are for.
- **enterpriseAudit({ reviewers, exporters, minInferredConfidence })** — AI-inferred facts
  below the confidence floor are hidden from everyone but reviewers; nothing leaves in an
  export unless the actor is an exporter. The audit trail does the rest.

Copy one, rename it, change the rule. Governance should read like a rule a person can
check, not a framework.

## What the store guarantees without any policy

- Sealed facts never surface unless asked for by classification.
- `nodeId`, `provenance`, `encryptionKeyRef`, raw `content` and the temporal-anchor trail are
  immutable after write, including through `restoreNode`; an attempt to change them throws.
- Invalidation closes `validTo` and keeps the record. Erasure exists — stewardship law needs
  it — but on a governed handle it runs `beforeErase` and is refused unless a policy allows it.

## The governed handle is the boundary

`govern()` is a capability, not a firewall around the process: it governs whoever calls
through it. Give applications, agents and MCP clients the governed handle; keep the inner store
where only the operator can reach it. Provenance is what the writer asserts — immutable once
written, not verified; if agents must never write `UserInput`, say so in a `beforeWrite`.
