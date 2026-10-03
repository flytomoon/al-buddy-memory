# Privacy

**Short version: your memory stays on your computer. We never see it, and nothing in this
software sends it anywhere.**

This page covers al-buddy-memory: the npm package, its MCP servers, its command line, and the Al
Buddy plugin for Claude Code. It was last reviewed on 2026-10-03.

## What is stored, and where

- Everything you or an assistant remembers is kept in one SQLite file on your machine:
  `~/.al-buddy-memory/brain.db`, or the path in `AL_BUDDY_MEMORY_DB`.
- The audit trail (who read or wrote what, and when) is inside that same file.
- The on-device search model is kept in `~/.al-buddy-memory/models`.
- An export is written only where you tell it to, readable by you only (file mode 0600).

There is no account, no sign-up, no API key and no server of ours involved.

## What the software contacts

Exactly two things, each once:

1. **The npm registry**, when `npx` first downloads the package (about 500 MB installed, most of it
   the optional on-device model runtime). This is npm's ordinary download; npm's own privacy terms
   apply to it.
2. **The Hugging Face hub**, to download the search model (all-MiniLM-L6-v2, about 90 MB) the first
   time the memory server starts. After that it runs offline. Set `AL_BUDDY_MEMORY_SEMANTIC=off` and
   it is never downloaded; recall then works by keyword only.

Nothing else. **No telemetry, no analytics, no crash reports, no "phone home".** Your memories are
never uploaded by this software, to us or to anyone.

## The one thing to know about assistants

The memory is local, but the assistant you use it with may not be. When Claude, Codex or ChatGPT
recalls a fact, that fact becomes part of your conversation with that assistant, and the
conversation is handled by its provider (Anthropic or OpenAI) under their terms — the same as
anything else you type there. The memory only ever hands an assistant what it asks for, and it
keeps facts that read like secrets (passwords, keys, tokens) classified Sensitive and out of every
assistant's recall.

## Deleting it

- Remove the `~/.al-buddy-memory` folder (or the file in `AL_BUDDY_MEMORY_DB`). That is all of it.
- Export first if you want a copy: `/al-buddy:export` in Claude Code, or
  `npx al-buddy-memory export --out ~/memory-backup.json`.
- Uninstalling the Claude Code plugin does not delete your memory; removing the folder does.

## The optional remote connector

`al-buddy-memory-http` is a separate server you would only run on purpose, to use the memory from
the Claude or ChatGPT apps. It listens on your own machine (127.0.0.1) and is reached only through
a tunnel you set up; it signs in with a passphrase you choose and keeps only hashes of it and of
its tokens. It is not part of the Claude Code plugin.

## Questions

Open an issue at <https://github.com/flytomoon/al-buddy-memory/issues>, or report a security
problem privately as described in [SECURITY.md](../SECURITY.md).
