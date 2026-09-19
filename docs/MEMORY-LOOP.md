# How the reference app uses this library

**What this is:** a worked example, not a description of this package. Al Buddy —
the assistant this library was extracted from — is a separate application in its
own repository. This page records how it wires the library into a working loop,
because "what do I actually do with a memory store" is the question the API docs
do not answer.

Everything named in `code font` below is exported by this package unless it is
explicitly marked *(app side)*, which means the reference app implements it and
you would write your own.

**Decision record:** [Memory architecture decision](./DECISION-2026-07-07.md)
**The contract:** [SPEC.md](./SPEC.md)

## The loop

1. **Load at session start.** The app opens a `ProjectMemory` and calls
   `renderBlock()` — a dense digest of the currently-valid facts, grouped by
   type and ranked by confidence — then puts that block in the model's context.
   In the reference app a session-start hook does this *(app side)*; in yours it
   might be the first message of a request.
2. **Capture as you talk.** When something durable is decided, the app calls
   `capture({ text, memoryType, provenance })`. The raw text is stored verbatim
   and is immutable afterwards; nothing is summarised away at write time.
3. **Recall on demand.** `recall(query)` full-text searches the whole archive
   when the block is not enough. With an embedder wired, `HybridRetriever`
   fuses the keyword and vector lists instead.
4. **Retire, never overwrite.** When a fact stops being true, `supersede(nodeId)`
   closes it with a `validTo` and keeps the record.
5. **Derive in the background.** `consolidate()` reads recent raw memory and
   writes **new** facts with provenance edges back to the raw they rest on. A
   derived fact that cites nothing is refused. `listConsolidations()` and
   `undoConsolidation()` let a whole pass be reviewed and taken back.

## Per-project silo

Each project gets its own database file. `projectDbPath(name)` resolves one under
`DEFAULT_MEMORY_DIR`; projects never bleed into each other. A cross-project view
would federate across them — the library does not do this for you.

## Why the block excludes superseded facts

`renderBlock` reads at `validAt = now`, so a fact that has been invalidated
(`validTo` set) drops out of the loaded context automatically but stays in the
archive. The assistant is given what is *currently* true and can still recall what
*used to be* true — `validAt` answers "what was true at X". Note the limit the
README states plainly: it does not answer "what did we believe at X", because an
update records that a change happened, not the prior value.

## What the reference app adds on top

These are the app's own components, built on the library's primitives. They are
listed because they are the parts people ask about, not because they ship here:

- **A curator** that distils salient facts from each exchange into typed
  `capture()` calls, run *after* the reply is sent so it adds no latency, and
  best-effort so a failure never breaks the chat.
- **Contradiction handling**: when a new fact makes an existing one outdated, the
  app supersedes the old one (`validTo`, never deleted) and records a
  `Contradiction` edge between them.
- **A read-only markdown mirror**, generated with `exportMemoryMarkdown()` and
  never read back, so a tampered file cannot become a false memory. The governed
  store stays the source of truth.
- **Procedural skills**: `Skill` nodes the assistant writes for itself, which then
  surface in the block and in recall like any other fact.

## Related

- [STARTER.md](./STARTER.md) — seeding a new memory so it is not empty on day one.
- [GOVERNANCE.md](./GOVERNANCE.md) — what `govern()` enforces around all of this.
