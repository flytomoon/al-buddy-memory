# The Build-Companion Memory Loop (Version 1)

**Status:** Shipped (2026-07-07)
**Decision record:** [Memory architecture decision](./DECISION-2026-07-07.md)

The first working version of Al Buddy's memory: the coding agent you talk to (today, Claude Code over Telegram) reads and writes Al Buddy's real memory store, so it stops forgetting between sessions. Al Buddy here is the memory _underneath_ the conversation, not a separate voice in the path (that's Version 2).

## The loop

1. **Load at session start.** A `SessionStart` hook (`.claude/settings.json`) runs `al-buddy memory session-start` and injects the project's **memory block** into the agent's context. The block is the dense, currently-valid digest, grouped by type, ranked by confidence.
2. **Capture as you talk.** When something salient is decided, the agent runs `al-buddy memory capture "<text>" [--type ...]`. Raw text is preserved verbatim, never summarized away.
3. **Recall on demand.** `al-buddy memory recall "<query>"` full-text searches the whole archive when the block isn't enough.

## Per-project silo

Each project gets its own database file (`~/.al-buddy/memory/<project>.db`), chosen by `--project`, else `AL_BUDDY_PROJECT`, else the working-directory name. Projects never bleed into each other. A future cross-project ("god view") query federates across them.

## Pieces

| Piece                                                        | Where                                        |
| ------------------------------------------------------------ | -------------------------------------------- |
| `ProjectMemory` (capture / recall / supersede / renderBlock) | `packages/core/src/memory/project-memory.ts` |
| `al-buddy memory <block\|capture\|recall\|session-start>`    | `packages/cli/src/memory-command.ts`         |
| SessionStart hook                                            | `.claude/settings.json`                      |
| Durable store underneath                                     | `SqliteMemoryStore` (schema 1.1.0)           |

## Why the block excludes superseded facts

`renderBlock` queries `validAt = now`, so a fact that was invalidated (`validTo` set) drops out of the loaded context automatically but stays in the archive. Bi-temporal memory in action: the companion loads what is _currently_ true, and can still recall what _used_ to be.

## Version 2 (shipped 2026-07-07)

Al Buddy runs as its own persistent, thinking companion — a real brain with memory, not just the coding agent's scratchpad.

- **Persistent + shared memory.** The Telegram companion (`packages/telegram/src/index.ts`) now uses `SqliteMemoryStore` at the per-project path, the _same_ store the build loop uses, so Al and the coding agent share one memory per project. It no longer forgets on restart.
- **Opens knowing you.** `renderMemoryBlock` loads the project's block into Al's system prompt at startup.
- **Auto-capture.** `MemoryCurator` (`packages/core/src/companion/memory-curator.ts`) uses the LLM to distill salient, durable facts from each exchange and store them (typed Belief/Lesson/Experience/Relationship/Skill), instead of dumping raw chatlog. Runs _after_ the reply is sent, so it never adds latency, and is best-effort (a curation failure never breaks the chat). `Companion` gains `captureTurns` to hand capture over to the curator.

Verified end-to-end with the real model: Al thought, auto-remembered 5 typed facts, and after a restart recalled all of them from the block having never been told again.

## Version 3 foundation (shipped 2026-07-07)

Tool use: Al can now call tools, starting with its own memory (`recall_memory`, `remember`). See tool-use.md. The pluggable next tool is `delegate_to_coding_agent` — Al orchestrating the build agents rather than just talking.

## Self-maintaining memory (shipped 2026-07-08)

Borrowed from OpenClaw/Hermes, built on our owned foundation:

- **Contradiction detection** (`memory-reconciler.ts`): when a new fact is captured, any existing memory it makes outdated is superseded (bi-temporal `validTo`, never deleted) + a Contradiction edge. Runs after capture in the daemon. "Moved London → Tokyo" retires London, history preserved.
- **Consolidation / "dream cycle"** (`memory-consolidator.ts`): a 6-hourly background pass rolls related memories into higher-level `Narrative` summaries — **additive** (links to raw, never flattens), idempotent (sources marked consolidated).
- **Read-only markdown mirror** (`memory-export.ts`, CLI `memory export`): a generated, human-readable export that is **never read back** — closes the false-memory tampering vector. Shows provenance + a "Retired" section (auditable history). Source of truth stays in the governed store.
- **Procedural skills** (`tools/skill-tools.ts`): `save_skill`/`list_skills` — Al writes reusable procedures (Skill nodes, surface in the block + recall).

## Not yet

- **`delegate_to_coding_agent` tool** — the executor that actually spawns/drives a coding agent (the wiring is done; only the executor is left).
- **Voice** — voice-note STT/TTS on Telegram is the cheap near-term option (see chat); realtime streaming is the dedicated-app phase.
- **Block refresh mid-session** (currently loaded once at startup; per-message recall covers freshness within a session).
