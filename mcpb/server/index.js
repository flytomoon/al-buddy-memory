// Claude Desktop starts this (see ../manifest.json). It is the same stdio
// memory server the Claude Code plugin runs, on the same database unless the
// user picked another file, so the two apps share one memory.
const db = (process.env.AL_BUDDY_MEMORY_DB ?? "").trim();
// An emptied setting must mean "the default file", never an unnamed database.
if (db === "" || db.includes("${")) delete process.env.AL_BUDDY_MEMORY_DB;
try {
  await import("./bin/al-buddy-memory-mcp.js");
} catch (err) {
  const where = `Node ${process.versions.node}, module ABI ${process.versions.modules}, ${process.platform}-${process.arch}`;
  console.error(`al-buddy-memory: the memory server could not start on this runtime (${where}): ${err instanceof Error ? err.message : String(err)}`);
  console.error("This bundle carries the SQLite engine for the Node.js built into Claude Desktop and for Node 22, 24, 25 and 26. Update the extension, or see https://albuddy.com/claude.html#desktop.");
  process.exit(1);
}
