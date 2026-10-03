# Getting started with the Claude plugin

**All your work with Claude is never lost — you have it forever and you can bring it anywhere.**

The Al Buddy plugin gives Claude Code a long-term memory that lives in one file on your machine.
Decisions, preferences and facts about your projects carry over from one session to the next. Each
fact keeps where it came from and since when it has been true, and a fact that stops being true is
retired, never overwritten. You can export the whole memory to one documented JSON file and take
it to another machine or another assistant.

## Install

You need Claude Code and Node.js 22 or later on your `PATH` (`node --version`).

In Claude Code:

```text
/plugin marketplace add flytomoon/al-buddy-memory
/plugin install al-buddy@al-buddy
```

Or from a shell:

```sh
claude plugin marketplace add flytomoon/al-buddy-memory
claude plugin install al-buddy@al-buddy
```

Start a new session (or run `/reload-plugins`). There is nothing to configure.

**The first start takes a minute.** The memory server is the `al-buddy-memory` npm package, run
with `npx` and pinned to an exact version. The first time, npx downloads it — about 500 MB
installed, most of it the optional on-device search runtime — and the server then downloads its
search model once, about 90 MB, from the Hugging Face hub. After that everything runs offline.

## Commands

| Command | What it does |
|---|---|
| `/al-buddy:recall <question>` | Search your memory and answer from it, with where each answer came from |
| `/al-buddy:remember <fact>` | Store a fact in your words (never a password or key) |
| `/al-buddy:forget <fact>` | Retire a fact: out of recall, kept in history with the date and reason |
| `/al-buddy:status` | How many facts, where the file is, when it last changed, whether semantic search is on |
| `/al-buddy:export [file]` | Save everything to one JSON file you own |
| `/al-buddy:import <file>` | Restore from an export, here or on another machine |
| `/al-buddy:help` | One screen: what it is, the commands, where the data is, how to delete it |

You do not have to use them. Claude recalls before answering about past work and remembers durable
facts on its own (the plugin's two skills), and every session starts with a short briefing — your
pinned rules, facts that mention the project folder, and the most recently learned facts, at most
2,000 characters.

## Where your data lives

- The memory: `~/.al-buddy-memory/brain.db`, created when the server first starts. To keep it
  elsewhere, set `AL_BUDDY_MEMORY_DB` to an absolute path in the environment Claude Code starts from.
- The search model: `~/.al-buddy-memory/models`.
- The audit trail of every read and write: inside the same database file.

Nothing leaves your machine except the two one-time downloads. See [PRIVACY.md](PRIVACY.md).

## Export and import

`/al-buddy:export` writes the complete memory — every fact, retired ones
included — to a new file in the [portable format](portable-format.schema.json), readable by you only.
It never overwrites a file. From a shell:

```sh
npx al-buddy-memory export --out ~/memory-backup.json         # the complete backup
npx al-buddy-memory export --format markdown > memory.md      # a readable mirror
npx al-buddy-memory import ~/memory-backup.json               # restore; safe to run twice
```

Import checks the whole file before writing anything. Any MCP client can then use the same memory:
see [Codex and the ChatGPT desktop app](#codex-and-the-chatgpt-desktop-app) below.

## Delete it

1. Export first if you want a copy.
2. Remove the `~/.al-buddy-memory` folder (or the file `AL_BUDDY_MEMORY_DB` names). That is all of it.

Uninstalling the plugin (`/plugin uninstall al-buddy@al-buddy`) does **not** delete your memory, so a
reinstall picks up where you left off.

## Privacy, in plain words

- Your memory is a file on your computer. We never see it. There is no account and no telemetry.
- The software contacts the internet twice, once each: npm for the package, Hugging Face for the
  search model.
- What Claude recalls becomes part of your conversation with Claude, which Anthropic handles under
  its terms, like anything else you type. Facts that read like passwords or keys are kept out of
  every assistant's recall.

The full statement: [PRIVACY.md](PRIVACY.md).

## Codex and the ChatGPT desktop app

The same memory works in Codex and the ChatGPT desktop app, which share one MCP configuration.

From a shell:

```sh
codex mcp add al-buddy-memory -- npx -y al-buddy-memory mcp
```

Or add this to `~/.codex/config.toml` (the longer start-up timeout covers the first download):

```toml
[mcp_servers.al-buddy-memory]
command = "npx"
args = ["-y", "al-buddy-memory", "mcp"]
startup_timeout_sec = 120
```

In the ChatGPT desktop app: **Settings → MCP servers → Add server**, choose **STDIO**, enter the name
`al-buddy-memory` and the command `npx -y al-buddy-memory mcp`, save, then **Restart**.

Claude Code and Codex then read and write the same `~/.al-buddy-memory/brain.db`, and each fact
records which assistant wrote it.

## Troubleshooting

- **The memory tools do not appear.** Run `/mcp` and look for `plugin:al-buddy:memory`. On the very
  first start, the download can outlast the connection timeout: wait a minute and run
  `/reload-plugins`.
- **"node: command not found", or a `better-sqlite3` build error.** Install Node.js 22 or later.
  Node 20 works only where `better-sqlite3` can compile from source (Python and a C++ toolchain).
- **Semantic search is off on an Intel Mac.** The on-device model runtime has no build for Intel
  Macs, so recall works by keyword only there. Everything else is the same. `/al-buddy:status` says
  which mode you are in and why.
- **Semantic search says "not downloaded yet".** The server fetches the model on its first start;
  with no network then, it stays keyword-only and tries again next start. To never download it, set
  `AL_BUDDY_MEMORY_SEMANTIC=off`.
- **No briefing at the start of a session.** It stays silent until you have memories, and the very
  first session (while the package downloads) gets none.
- **Anything else:** <https://github.com/flytomoon/al-buddy-memory/issues>.
