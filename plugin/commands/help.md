---
description: What Al Buddy Memory is, its commands, where your memory lives, and how to delete it.
disable-model-invocation: true
---

Show the user this, as written, and nothing else:

**Al Buddy Memory** — your work with Claude, never lost. Decisions, preferences and facts are kept across sessions in one file on your machine, each with where it came from and since when it has been true. Nothing is overwritten: a fact that stops being true is retired and kept in history. You can export it all and take it anywhere.

| Command | What it does |
|---|---|
| `/al-buddy:recall <question>` | Search your memory and answer from it |
| `/al-buddy:remember <fact>` | Store a fact (never passwords or keys) |
| `/al-buddy:forget <fact>` | Retire a fact — kept in history, out of recall |
| `/al-buddy:status` | How much is remembered, where, last write, semantic search |
| `/al-buddy:export [file]` | Save everything to one JSON file you own |
| `/al-buddy:import <file>` | Restore from an export |
| `/al-buddy:help` | This screen |

Claude also recalls and remembers on its own when it matters, and each session starts with a short briefing of your pinned rules and recent facts.

**Where it lives:** `~/.al-buddy-memory/brain.db` (or `AL_BUDDY_MEMORY_DB`), plus the search model in `~/.al-buddy-memory/models`. Nothing is sent anywhere: no account, no telemetry.

**To delete it:** `/al-buddy:export` first if you want a copy, then remove the `~/.al-buddy-memory` folder. Uninstalling the plugin (`/plugin uninstall al-buddy@al-buddy`) leaves your memory in place.

Guide and privacy: https://albuddy.com/claude.html
