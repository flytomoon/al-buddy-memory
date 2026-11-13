import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { SqliteMemoryStore } from "../dist/index.js";

const name = "al-buddy-memory";
const serverEnv = () => ({ AL_BUDDY_MEMORY_SEMANTIC: "off", ...(process.env.AL_BUDDY_MEMORY_DB ? { AL_BUDDY_MEMORY_DB: process.env.AL_BUDDY_MEMORY_DB } : {}) });
const server = () => ({ command: "npx", args: ["-y", "al-buddy-memory", "mcp"], env: serverEnv() });

function command(binary, args) {
  return spawnSync(binary, args, { encoding: "utf8", timeout: 15_000, stdio: "pipe" });
}

function configureCli(binary, addArgs) {
  const found = command(binary, ["mcp", "get", name]);
  if (found.error?.code === "ENOENT") return `${binary}: CLI not installed; configure it after installing ${binary}`;
  if (found.error) throw new Error(`${binary}: ${found.error.message}`);
  if (found.status === 0) return `${binary}: server entry already exists`;
  const added = command(binary, addArgs);
  if (added.error || added.status !== 0) {
    throw new Error(`${binary}: ${added.error?.message ?? added.stderr?.trim() ?? `exit ${added.status}`}`);
  }
  return `${binary}: server entry added`;
}

function configureCursor(home) {
  const file = join(home, ".cursor", "mcp.json");
  let config = {};
  if (existsSync(file)) {
    try {
      config = JSON.parse(readFileSync(file, "utf8"));
    } catch (err) {
      throw new Error(`Cursor: cannot parse ${file}: ${err.message}`);
    }
    if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error(`Cursor: ${file} must be a JSON object`);
  }
  if (config.mcpServers !== undefined && (!config.mcpServers || typeof config.mcpServers !== "object" || Array.isArray(config.mcpServers))) {
    throw new Error(`Cursor: mcpServers in ${file} must be a JSON object`);
  }
  const entries = config.mcpServers ?? {};
  if (entries[name] !== undefined) return "Cursor: server entry already exists";
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify({ ...config, mcpServers: { ...entries, [name]: server() } }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    renameSync(temp, file);
  } finally {
    if (existsSync(temp)) unlinkSync(temp);
  }
  return `Cursor: server entry added to ${file}`;
}

export function init() {
  const home = homedir();
  const db = process.env.AL_BUDDY_MEMORY_DB ?? join(home, ".al-buddy-memory", "brain.db");
  const store = new SqliteMemoryStore(db);
  store.close();
  const lines = [`Memory: ${db}`];
  let attempted = 0;
  let succeeded = 0;
  let failed = 0;
  let consecutiveFailures = 0;
  const tasks = [
    () => configureCli("claude", ["mcp", "add", "--scope", "user", name, "-e", ...Object.entries(serverEnv()).map(([key, value]) => `${key}=${value}`), "--", "npx", "-y", "al-buddy-memory", "mcp"]),
    () => configureCursor(home),
    () => configureCli("codex", ["mcp", "add", name, ...Object.entries(serverEnv()).flatMap(([key, value]) => ["--env", `${key}=${value}`]), "--", "npx", "-y", "al-buddy-memory", "mcp"]),
  ];
  for (const task of tasks) {
    attempted++;
    try {
      const line = task();
      lines.push(line);
      if (line.includes("not installed")) {
        consecutiveFailures++;
      } else {
        succeeded++;
        consecutiveFailures = 0;
      }
    } catch (err) {
      failed++;
      consecutiveFailures++;
      lines.push(err.message);
    }
    if (consecutiveFailures >= 3) {
      lines.push("Stopped after three consecutive client configuration failures");
      break;
    }
  }
  lines.push("Restart each configured client, then ask it to remember a fact.");
  return { lines, attempted, succeeded, failed };
}
