#!/usr/bin/env node
// Usage: node bench/locomo/download.mjs
//
// Downloads the two files the LoCoMo benchmark reads into bench/locomo/data/
// (git-ignored; the data is CC BY-NC and never committed): the ten
// conversations from snap-research/locomo, and the independent audit's list
// of wrong answers from dial481/locomo-audit. Each comes from the commit named
// in dataset.json, never a branch, and a file whose SHA-256 differs from the
// one recorded there is refused and not kept. A file already present is only
// verified. The last line printed is "RESULT: ...".
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { downloadFile, readManifest, verifyFile } from "../longmemeval/download.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const MANIFEST_PATH = join(HERE, "dataset.json");
export const DATA_DIR = join(HERE, "data");

export const readLocomoManifest = (path = MANIFEST_PATH) => readManifest(path);

/** Where a pinned file lives on disk: data/<repo owner>/<its path>, so the two repos' files cannot collide. */
export function localPath(file, dataDir = DATA_DIR) {
  return join(dataDir, file.repo.split("/")[0], file.path);
}

/**
 * The immutable URLs of one file, tried in order: GitHub's contents API with
 * the raw media type, then raw.githubusercontent.com — both at the pinned
 * commit, so either serves the same bytes.
 */
export function fileUrls(file) {
  if (!/^[0-9a-f]{40}$/.test(file.commit ?? "")) throw new Error(`dataset.json names no commit for ${file.repo}/${file.path}`);
  return [
    { url: `https://api.github.com/repos/${file.repo}/contents/${file.path}?ref=${file.commit}`, headers: { Accept: "application/vnd.github.raw" } },
    { url: `https://raw.githubusercontent.com/${file.repo}/${file.commit}/${file.path}`, headers: {} },
  ];
}

/**
 * Make sure every file in the manifest is on disk and is the pinned one.
 * Returns one line per file; throws (naming every URL tried and why it
 * failed) when a file cannot be had.
 */
export async function ensureFiles(manifest = readLocomoManifest(), { dataDir = DATA_DIR, fetchImpl = fetch, log = () => {} } = {}) {
  const lines = [];
  for (const [key, file] of Object.entries(manifest.files)) {
    if (!file.sha256) throw new Error(`dataset.json records no SHA-256 for ${key}`);
    const dest = localPath(file, dataDir);
    if (existsSync(dest)) {
      const wrong = await verifyFile(dest, file);
      if (wrong) throw new Error(`${dest} is not the pinned file (${wrong}). Delete it and run again.`);
      lines.push(`${key}: ${dest} present and verified`);
      continue;
    }
    const failures = [];
    for (const { url, headers } of fileUrls(file)) {
      log(`Downloading ${url} …`);
      try {
        const got = await downloadFile(url, dest, file, (u, init) => fetchImpl(u, { ...init, headers }));
        lines.push(`${key}: ${got.bytes} bytes, SHA-256 ${got.sha256}, verified`);
        failures.length = 0;
        break;
      } catch (e) {
        failures.push(`${url}: ${e.message}`);
      }
    }
    if (failures.length) throw new Error(`Could not download ${file.repo}/${file.path} at ${file.commit}:\n  ${failures.join("\n  ")}`);
  }
  return lines;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const lines = await ensureFiles(readLocomoManifest(), { log: (l) => console.log(l) });
    for (const l of lines) console.log(l);
    console.log(`RESULT: the LoCoMo data and the audit key are in ${DATA_DIR} and match their pinned SHA-256s.`);
  } catch (e) {
    console.error(e.message);
    console.log(`RESULT: the LoCoMo download failed, so nothing was run (${e.message.split("\n")[0]}).`);
    process.exit(1);
  }
}
