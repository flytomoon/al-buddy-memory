#!/usr/bin/env node
// Usage: node bench/longmemeval/download.mjs [--variant s|oracle|all] [--pin]
//
// Downloads the LongMemEval data into bench/longmemeval/data/ (git-ignored; the
// dataset is never committed) from the dataset commit named in dataset.json,
// and refuses any file whose SHA-256 differs from the one recorded there.
//
// --pin records that commit and those checksums, once: it asks the Hugging Face
// API which commit `main` is and for the SHA-256 Hugging Face itself holds for
// each file (its LFS object id), writes both into dataset.json, then downloads
// and verifies against them. Commit the updated dataset.json; from then on every
// download is checked against it.
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const HERE = dirname(fileURLToPath(import.meta.url));
export const MANIFEST_PATH = join(HERE, "dataset.json");
export const DATA_DIR = join(HERE, "data");

export function readManifest(path = MANIFEST_PATH) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** The immutable URL of one file: the dataset commit, never a branch. */
export function fileUrl(manifest, key) {
  const file = manifest.files[key];
  if (!file) throw new Error(`dataset.json has no file "${key}" (have: ${Object.keys(manifest.files).join(", ")})`);
  if (!manifest.revision) throw new Error("dataset.json names no dataset commit yet — run with --pin once");
  return `https://huggingface.co/datasets/${manifest.repo}/resolve/${manifest.revision}/${file.path}`;
}

export async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

/** Why `path` is not the pinned file, or null when it is. */
export async function verifyFile(path, file) {
  if (!file.sha256) return "dataset.json records no SHA-256 for it";
  if (file.bytes !== null && file.bytes !== undefined && statSync(path).size !== file.bytes) return `size ${statSync(path).size}, expected ${file.bytes}`;
  const actual = await sha256File(path);
  return actual === file.sha256 ? null : `SHA-256 ${actual}, expected ${file.sha256}`;
}

async function getJson(fetchImpl, url) {
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`GET ${url}: HTTP ${res.status}`);
  return res.json();
}

/**
 * dataset.json with `revision` set to the commit `main` points at now, and each
 * file's SHA-256 and size as the Hugging Face API reports them for that commit.
 */
export async function pinManifest(manifest, fetchImpl = fetch, now = new Date()) {
  const info = await getJson(fetchImpl, `https://huggingface.co/api/datasets/${manifest.repo}/revision/main`);
  if (typeof info.sha !== "string" || !/^[0-9a-f]{40}$/.test(info.sha)) throw new Error("The Hugging Face API returned no commit sha for main");
  const tree = await getJson(fetchImpl, `https://huggingface.co/api/datasets/${manifest.repo}/tree/${info.sha}`);
  const files = {};
  for (const [key, file] of Object.entries(manifest.files)) {
    const entry = tree.find((e) => e.path === file.path);
    if (!entry) throw new Error(`${file.path} is not in ${manifest.repo} at ${info.sha}`);
    const oid = entry.lfs?.oid;
    files[key] = { path: file.path, sha256: typeof oid === "string" && /^[0-9a-f]{64}$/.test(oid) ? oid : null, bytes: entry.lfs?.size ?? entry.size ?? null };
  }
  return { ...manifest, revision: info.sha, pinnedAt: now.toISOString(), files };
}

/**
 * Stream `url` to `dest` through a SHA-256, and keep it only if it matches
 * `file`. When `file.sha256` is null (only possible straight after --pin, for a
 * file Hugging Face reports no LFS id for) the computed one is returned to be
 * recorded.
 */
export async function downloadFile(url, dest, file, fetchImpl = fetch) {
  mkdirSync(dirname(dest), { recursive: true });
  const part = `${dest}.part`;
  const res = await fetchImpl(url, { redirect: "follow" });
  if (!res.ok || !res.body) throw new Error(`GET ${url}: HTTP ${res.status}`);
  const hash = createHash("sha256");
  let bytes = 0;
  const out = createWriteStream(part);
  try {
    for await (const chunk of res.body) {
      hash.update(chunk);
      bytes += chunk.length;
      if (!out.write(chunk)) await once(out, "drain");
    }
    out.end();
    await once(out, "finish");
  } catch (e) {
    out.destroy();
    rmSync(part, { force: true });
    throw e;
  }
  const sha256 = hash.digest("hex");
  const wrong =
    file.sha256 && sha256 !== file.sha256 ? `SHA-256 ${sha256}, expected ${file.sha256}` : file.bytes !== null && file.bytes !== undefined && bytes !== file.bytes ? `${bytes} bytes, expected ${file.bytes}` : null;
  if (wrong) {
    rmSync(part, { force: true });
    throw new Error(`${url}: ${wrong} — nothing kept`);
  }
  renameSync(part, dest);
  return { sha256, bytes };
}

async function main() {
  const { values } = parseArgs({ options: { variant: { type: "string", default: "s" }, pin: { type: "boolean", default: false } } });
  let manifest = readManifest();
  const keys = values.variant === "all" ? Object.keys(manifest.files) : [values.variant];
  for (const key of keys) if (!manifest.files[key]) throw new Error(`Unknown variant "${key}" (have: ${Object.keys(manifest.files).join(", ")}, all)`);

  if (values.pin) {
    manifest = await pinManifest(manifest);
    writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`Pinned ${manifest.repo} at ${manifest.revision}; commit bench/longmemeval/dataset.json.`);
  } else if (!manifest.revision || keys.some((k) => !manifest.files[k].sha256)) {
    throw new Error("dataset.json is not pinned yet (no dataset commit or no SHA-256). Run once with --pin, check the result, and commit dataset.json.");
  }

  for (const key of keys) {
    const file = manifest.files[key];
    const dest = join(DATA_DIR, file.path);
    if (existsSync(dest)) {
      const wrong = await verifyFile(dest, file);
      if (!wrong) {
        console.log(`${file.path}: present and verified (${file.sha256}).`);
        continue;
      }
      throw new Error(`${dest} is not the pinned file (${wrong}). Delete it and run again.`);
    }
    const url = fileUrl(manifest, key);
    console.log(`Downloading ${url} …`);
    const got = await downloadFile(url, dest, file);
    if (!file.sha256) {
      manifest.files[key] = { ...file, sha256: got.sha256, bytes: got.bytes };
      writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
      console.log(`${file.path}: Hugging Face reported no SHA-256; recorded the downloaded file's (${got.sha256}).`);
    }
    console.log(`${file.path}: ${got.bytes} bytes, SHA-256 ${got.sha256}, verified.`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
