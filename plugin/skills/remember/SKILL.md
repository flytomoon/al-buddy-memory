---
name: remember
description: Store a durable fact in the user's long-term memory — a decision, a preference, a convention, a fact about a person or project — when the user states one or asks you to remember something. Never for secrets, credentials, small talk, or one-off requests.
argument-hint: <fact>
---

# Remember durable facts, and nothing else

Use the `memory` server's `remember` tool when something will still matter in a future session:

- A decision and its reason ("we chose SQLite over Postgres because it must run offline").
- A preference or convention ("prefers British English", "tests live beside the code").
- A stable fact about a person, project or setup ("the staging host is staging.example.com").
- Anything the user explicitly asks you to remember.

## How to write a fact

- One plain sentence that stands on its own, without "this" or "the above". Name the project or person.
- Use `provenance: "UserInput"` for what the user said and `"AIInferred"` for your own conclusion.
- `remember` returns `mayConflictWith`: current facts this one may be correcting. Read them. If one stopped being true, call `invalidate` with its id and `replacedBy` set to the new fact's id. Nothing is ever deleted; the old fact is retired and kept.
- Use `pin` only for a rule that belongs in every conversation. The pinned tier is small.

## Never store

- Passwords, API keys, tokens, private keys, recovery codes, card or account numbers, or anything that grants access. The server classifies text that reads like a secret as Sensitive and hides it from every assistant, so storing one helps nobody. Leave it out.
- Small talk, one-off requests, or the contents of files the user can simply reopen.
- Anything the user asks you not to keep.

If you are unsure whether something is durable, ask the user before storing it.

When the user runs `/al-buddy:remember <fact>`, the fact arrives as ARGUMENTS: store it with `provenance: "UserInput"`, in their words made to stand on its own, then confirm in one line and mention any `mayConflictWith` fact they may want retired. Refuse a secret, and say why.
