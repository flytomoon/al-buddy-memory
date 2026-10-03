#!/usr/bin/env node
// npm run build:mcpb — the Claude Desktop extension (an MCP Bundle, .mcpb):
// the stdio memory server with every dependency inside, so it installs with a
// double-click and needs nothing on the machine. Spec:
// https://github.com/modelcontextprotocol/mcpb/blob/main/MANIFEST.md
//
// The one hard part is the SQLite engine (better-sqlite3), a native module
// built per runtime ABI. Claude Desktop runs Node extensions on the Node.js
// built into its Electron (a UtilityProcess) unless the user switched that off,
// in which case it uses the system Node. So the bundle carries one binary per
// (runtime ABI, platform, arch): Electron's, built from source against
// Electron's headers (better-sqlite3 publishes no prebuild for it yet), plus
// the published prebuilds for Node 22, 24, 25 and 26. They sit where
// `bindings` looks for them — lib/binding/node-v<ABI>-<platform>-<arch>/ —
// and the generic build/Release copy is removed so the right one is chosen.
//
// macOS only for now: the Electron binary is compiled on this machine, and a
// Windows one needs a Windows build host (the manifest says darwin).
//
//   npm run build:mcpb [-- --electron 44.4.3]
//   → build/mcpb/al-buddy-memory.mcpb (and the staging folder beside it)
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
// Claude Desktop's Electron, as of 2026-10-03 (Claude 2.19675.0 ships Electron 44.4.3, ABI 149).
const ELECTRON = flag("--electron", "44.4.3");
const NODE_ABIS = [127, 137, 141, 147]; // Node 22, 24, 25, 26
const TARGETS = [
  { platform: "darwin", arch: "arm64" },
  { platform: "darwin", arch: "x64" },
];
const out = join(root, "build", "mcpb");
const stage = join(out, "stage");
const run = (cmd, argv, opts = {}) => execFileSync(cmd, argv, { stdio: "inherit", ...opts });
const step = (text) => console.log(`→ ${text}`);

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
if (!existsSync(join(root, "dist", "index.js"))) throw new Error("dist/ is missing: run npm run build first");

step(`staging ${pkg.name} ${pkg.version} in ${stage}`);
rmSync(out, { recursive: true, force: true });
mkdirSync(join(stage, "server"), { recursive: true });
cpSync(join(root, "dist"), join(stage, "server", "dist"), { recursive: true, filter: (p) => !/\.(d\.ts|map)$/.test(p) });
cpSync(join(root, "bin"), join(stage, "server", "bin"), { recursive: true });
cpSync(join(root, "mcpb", "server", "index.js"), join(stage, "server", "index.js"));
cpSync(join(root, "docs", "demo", "al-icon.png"), join(stage, "icon.png"));
cpSync(join(root, "LICENSE"), join(stage, "LICENSE"));
const manifest = JSON.parse(readFileSync(join(root, "mcpb", "manifest.json"), "utf8"));
manifest.version = pkg.version;
writeFileSync(join(stage, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

// The runtime dependencies at the versions the lockfile pins, without dev tools or install scripts.
const { devDependencies: _dev, scripts: _scripts, ...runtimePkg } = pkg;
writeFileSync(join(stage, "package.json"), JSON.stringify({ ...runtimePkg, type: "module" }, null, 2) + "\n");
// The server reads its version from the package.json two levels above dist/mcp/.
writeFileSync(join(stage, "server", "package.json"), JSON.stringify({ name: pkg.name, version: pkg.version, type: "module", private: true }, null, 2) + "\n");
cpSync(join(root, "package-lock.json"), join(stage, "package-lock.json"));
step("npm ci --omit=dev --ignore-scripts");
run("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: stage });
rmSync(join(stage, "package-lock.json"));

const bs = join(stage, "node_modules", "better-sqlite3");
const bsVersion = JSON.parse(readFileSync(join(bs, "package.json"), "utf8")).version;
const bindingDir = (abi, t) => join(bs, "lib", "binding", `node-v${abi}-${t.platform}-${t.arch}`);

step(`better-sqlite3 ${bsVersion}: Node prebuilds for ABIs ${NODE_ABIS.join(", ")}`);
const tmp = join(out, "tmp");
mkdirSync(tmp, { recursive: true });
for (const t of TARGETS)
  for (const abi of NODE_ABIS) {
    const name = `better-sqlite3-v${bsVersion}-node-v${abi}-${t.platform}-${t.arch}.tar.gz`;
    const file = join(tmp, name);
    run("curl", ["-fsSL", "-o", file, `https://github.com/WiseLibs/better-sqlite3/releases/download/v${bsVersion}/${name}`]);
    const x = join(tmp, `x-${abi}-${t.platform}-${t.arch}`);
    mkdirSync(x, { recursive: true });
    run("tar", ["-xzf", file, "-C", x]);
    mkdirSync(bindingDir(abi, t), { recursive: true });
    cpSync(join(x, "build", "Release", "better_sqlite3.node"), join(bindingDir(abi, t), "better_sqlite3.node"));
  }

const electronAbi = Number(run("node", ["-p", `require(${JSON.stringify(join(root, "node_modules", "node-abi"))}).getAbi(${JSON.stringify(ELECTRON)}, "electron")`], { stdio: ["ignore", "pipe", "inherit"] }).toString().trim());
step(`better-sqlite3 for Electron ${ELECTRON} (ABI ${electronAbi}), compiled from source`);
for (const t of TARGETS) {
  const src = join(tmp, `src-${t.arch}`);
  cpSync(bs, src, { recursive: true, filter: (p) => !p.includes(`${join("lib", "binding")}`) });
  run("npx", ["--yes", "node-gyp@11", "rebuild", `--directory=${src}`, `--target=${ELECTRON}`, `--arch=${t.arch}`, "--dist-url=https://electronjs.org/headers", "--release"], {
    stdio: ["ignore", "ignore", "inherit"],
    // Apple's libtool, not a GNU one earlier on PATH (which rejects -static).
    env: { ...process.env, PATH: `/usr/bin:${process.env.PATH}` },
  });
  mkdirSync(bindingDir(electronAbi, t), { recursive: true });
  cpSync(join(src, "build", "Release", "better_sqlite3.node"), join(bindingDir(electronAbi, t), "better_sqlite3.node"));
}
// Without this, `bindings` finds the generic copy first and never reaches the per-ABI ones.
rmSync(join(bs, "build"), { recursive: true, force: true });
for (const d of ["src", "deps"]) rmSync(join(bs, d), { recursive: true, force: true });

// The on-device model runtime: keep the macOS build (Apple silicon; Intel Macs have none and run keyword-only).
const ortBin = join(stage, "node_modules", "onnxruntime-node", "bin");
for (const napi of readdirSync(ortBin))
  for (const platform of readdirSync(join(ortBin, napi)))
    if (platform !== "darwin") rmSync(join(ortBin, napi, platform), { recursive: true, force: true });
rmSync(tmp, { recursive: true, force: true });

const mcpb = (argv) => run("npx", ["--yes", "@anthropic-ai/mcpb@2", ...argv], { cwd: out });
step("mcpb validate");
mcpb(["validate", join(stage, "manifest.json")]);
step("mcpb pack");
mcpb(["pack", stage, join(out, "al-buddy-memory.mcpb")]);
console.log(`\nBuilt ${join(out, "al-buddy-memory.mcpb")}`);
