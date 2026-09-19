import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Expand a leading `~` to the home directory.
 *
 * A shell does this before a program ever sees the argument; an MCP host's JSON
 * config does not. `"AL_BUDDY_MEMORY_DB": "~/.al-buddy-memory/brain.db"` — the
 * value the README published until 0.4.2 — therefore created a literal `./~/`
 * directory under whatever the client's working directory happened to be, or
 * failed outright where that directory was not writable (R4, release review
 * 2026-09-18).
 *
 * `~user/...` is left alone: resolving another account's home needs the password
 * database, and guessing at it would put memory somewhere nobody asked for.
 */
export function expandHome(path: string, home: string = homedir()): string {
  if (path === "~") return home;
  if (path.startsWith("~/") || path.startsWith("~\\")) return join(home, path.slice(2));
  return path;
}
