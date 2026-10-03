# Al Buddy Memory for Claude Code

**All your work with Claude is never lost — you have it forever and you can bring it anywhere.**

Long-term memory that stays on your machine. Claude remembers decisions, preferences and facts
about your projects across sessions, and every fact keeps where it came from, since when it has
been true, and what replaced it. Nothing is overwritten: a fact that stops being true is retired
and kept. Your memory is one SQLite file you own, and it exports to one documented JSON format.

## Install

```text
/plugin marketplace add flytomoon/al-buddy-memory
/plugin install al-buddy@al-buddy
```

## Commands

- `/al-buddy:recall <question>` — search your memory and answer from it.
- `/al-buddy:remember <fact>` — store a fact (never a password or key).
- `/al-buddy:forget <fact>` — retire a fact: out of recall, kept in history.
- `/al-buddy:status` — how many facts, where the file is, last write, whether semantic search is on.
- `/al-buddy:export [file]` — save everything to one JSON file you own.
- `/al-buddy:import <file>` — restore from an export.
- `/al-buddy:help` — one screen on all of it.

Getting started, troubleshooting and the Codex / ChatGPT desktop setup: https://albuddy.com/claude.html
(also [docs/claude-plugin.md](https://github.com/flytomoon/al-buddy-memory/blob/main/docs/claude-plugin.md)).

## What you get

- **An MCP server** (`memory`) with the tools `remember`, `recall`, `history`, `explain`,
  `invalidate`, `pin`, `unpin`, `pinned`, `mental_model`, `define_mental_model` and `export`.
  Every recalled fact carries its provenance, validity and confidence.
- **Two skills**, which are also the `/al-buddy:recall` and `/al-buddy:remember` commands. `recall`
  has Claude search memory before answering about past work or decisions. `remember` has Claude
  store durable facts, and never secrets or credentials.
- **Five commands** for the things you start yourself: `forget`, `status`, `export`, `import`, `help`.
- **A session-start briefing.** When a session starts, is cleared, or is compacted, a hook adds a
  short summary (at most 2,000 characters): your pinned rules, facts that mention the project
  folder's name, and the most recently learned facts. It prints nothing until you have memories.

## Where your data lives

Everything is local. The memory is `~/.al-buddy-memory/brain.db`, created the first time the
server starts. To keep it elsewhere, set `AL_BUDDY_MEMORY_DB` to an absolute path in the
environment Claude Code starts from. The audit trail of every read and write is inside the same
file.

Recall is hybrid (keyword and meaning) using a small on-device embedding model. The model is
downloaded once from the Hugging Face hub (about 90 MB, to `~/.al-buddy-memory/models`) and then
runs offline. Until it has loaded, or if it cannot load on your platform, recall is keyword-only
and keeps working. Set `AL_BUDDY_MEMORY_SEMANTIC=off` to never download it.

## What it runs and what it contacts

- The server and the hook run the `al-buddy-memory` package from npm with `npx`, pinned to an
  exact version. The first start downloads it (about 500 MB installed, most of it the optional
  on-device model runtime) into npm's cache.
- The one-time model download from huggingface.co described above.
- Nothing else. No account, no API key, no telemetry; your memories are never sent anywhere by this
  software. (What Claude recalls becomes part of your conversation with Claude, like anything you
  type.) Privacy statement: https://github.com/flytomoon/al-buddy-memory/blob/main/docs/PRIVACY.md

Needs Node.js 22 or later on your `PATH`.

## Export, back up, remove

- Run `/al-buddy:export`, or `npx -y al-buddy-memory@0.10.1 export --out ~/memory-backup.json`
  for the complete owner backup (Sensitive facts included). `--format markdown` writes a readable
  mirror instead. `npx -y al-buddy-memory@0.10.1 import <file>` restores a backup.
- Uninstalling the plugin (`/plugin uninstall al-buddy@al-buddy`) does not delete your
  memory. To delete it, remove `~/.al-buddy-memory/`.

Source, documentation and the governance model: https://github.com/flytomoon/al-buddy-memory.
Licensed under Apache-2.0.
