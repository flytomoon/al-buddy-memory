---
description: Save your whole memory to one JSON file you own — the documented portable format, ready to back up or take to another assistant.
argument-hint: "[file.json]"
disable-model-invocation: true
---

Export the user's complete memory to a new file.

1. The file is `$ARGUMENTS` if given, else `~/al-buddy-memory-backup-<today as YYYY-MM-DD>.json`. It must not exist yet (the export never overwrites); if it does, ask for another name.
2. Run:

   ```
   npx -y --package=al-buddy-memory@0.10.1 al-buddy-memory export --out <file>
   ```

   Add `--format markdown` (and a `.md` name) only if the user asked for something readable rather than a backup.
3. Report the path and size from the command's output. Say that this is the complete owner backup, Sensitive facts included, readable only by them (mode 0600), and that `/al-buddy:import <file>` restores it here or on another machine.

Do not open, read, or print the exported file.
