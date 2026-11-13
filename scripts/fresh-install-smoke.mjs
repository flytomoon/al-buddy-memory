import assert from "node:assert/strict";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({ name: "fresh-install-smoke", version: "1" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [process.env.AL_BUDDY_MEMORY_SMOKE_BIN ?? join(process.cwd(), "node_modules", "al-buddy-memory", "bin", "al-buddy-memory.js"), "mcp"],
  env: { ...process.env, AL_BUDDY_MEMORY_SEMANTIC: "off" },
});
const call = async (name, args) => {
  const result = await client.callTool({ name, arguments: args });
  assert(!result.isError, `${name} returned an MCP error: ${result.content?.[0]?.text ?? "unknown"}`);
  return JSON.parse(result.content.find((part) => part.type === "text").text);
};

try {
  await client.connect(transport);
  const old = await call("remember", { text: "I live in Tokyo" });
  const current = await call("remember", { text: "I live in Berlin" });
  await call("invalidate", { id: old.id, replacedBy: current.id, reason: "I moved to Berlin" });
  const recalled = await call("recall", { query: "live", includeSuperseded: true });
  assert(recalled.some((fact) => fact.id === current.id && fact.current));
  assert(recalled.some((fact) => fact.id === old.id && !fact.current && fact.supersededBy === current.id));
  const explanation = await call("explain", { id: current.id });
  assert.equal(explanation.fact.id, current.id);
  console.log("RESULT: 1/1 packed MCP memory demos succeeded");
} catch (error) {
  console.error(error);
  console.error("RESULT: 0/1 packed MCP memory demos succeeded");
  process.exitCode = 1;
} finally {
  await client.close();
}
