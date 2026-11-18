/**
 * The sidecar OmniMemEval's `al_buddy` client calls: one SqliteMemoryStore
 * file per benchmark user, behind three routes on 127.0.0.1.
 *
 *   POST /add     {user_id, messages: [{role, content, name?, chat_time?}]}
 *   POST /search  {user_id, query, top_k, question_date?} → {memories: [text]}
 *   POST /delete  {user_id}
 *   GET  /health, GET /stats
 *
 * Write: every non-empty message becomes one memory, as said (`UserInput`
 * for a user turn, `AIInferred` for an assistant's), a `Conversation` valid
 * from its `chat_time`; then the new memories are embedded on the device.
 * Nothing is extracted or rewritten and no model is called. Search: the
 * library's `HybridRetriever.recall` with `expand` read against the
 * question's date (or, without one, the last date the user's memory holds),
 * the same pool our own LoCoMo and LongMemEval runs ask for; the first
 * `top_k` come back best first, each led by its date.
 *
 * A user's operations run one at a time, in arrival order; different users
 * run side by side. Every failure is an HTTP error carrying its reason —
 * never an empty result — so the harness records it as a failed search.
 *
 * Run: `node bench/omnimemeval/server.mjs --port 8765 --state-dir <dir>`
 * (needs `npm run build`; `--retrieval keyword` skips the embedder).
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

/** How many memories one recall asks for, as bench/locomo and bench/longmemeval do; the first `top_k` are returned. */
export const RECALL_POOL = 100;
/** Request bodies above this are refused (a BEAM session batch is a few MB at most). */
export const MAX_BODY_BYTES = 64 * 1024 * 1024;

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * A benchmark date as an ISO instant, or null. Reads ISO 8601 and the
 * LongMemEval form "2023/05/20 (Sat) 02:21" (taken as UTC, as
 * bench/longmemeval does); anything else that `Date` parses, too.
 */
export function parseBenchDate(text) {
  if (typeof text !== "string" || text.trim() === "") return null;
  const t = text.trim();
  const lme = /^(\d{4})\/(\d{2})\/(\d{2})(?: \([A-Za-z]{3}\))?(?: (\d{2}):(\d{2}))?$/.exec(t);
  if (lme) {
    const [, y, mo, d, h = "00", mi = "00"] = lme;
    const ms = Date.UTC(+y, +mo - 1, +d, +h, +mi);
    const iso = new Date(ms).toISOString();
    return iso.startsWith(`${y}-${mo}-${d}T${h}:${mi}`) ? iso : null;
  }
  // A bare date-time with no zone is read as UTC, not as this machine's zone.
  const zoned = /[zZ]|[+-]\d{2}:?\d{2}$/.test(t) || !/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(t) ? t : `${t.replace(" ", "T")}Z`;
  const ms = Date.parse(zoned);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** "2023-05-08T13:56:00.000Z" → "2023-05-08 13:56". */
export function dateLabel(iso) {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

/**
 * The line the reader sees for one memory: its date (when the message had
 * one), then who said it — LoCoMo's turns already begin "<speaker>: ", any
 * other message gets its role — then the text.
 */
export function memoryLine({ text, role, name, at }) {
  const speaker = name && text.startsWith(`${name}: `) ? "" : `${role}: `;
  return `${at ? `[${dateLabel(at)}] ` : ""}${speaker}${text}`;
}

/** A user's store file stem: a hash, so any user_id is a safe file name. */
export function userFileStem(userId) {
  return createHash("sha256").update(userId).digest("hex").slice(0, 32);
}

function requireUser(body) {
  const u = body?.user_id;
  if (typeof u !== "string" || u === "" || u.length > 512) throw new HttpError(400, "user_id must be a non-empty string of at most 512 characters");
  return u;
}

/**
 * The sidecar's logic, without the HTTP: `add`, `search`, `remove`, `stats`,
 * `close`. `lib` is the library (the built package, or the source in tests);
 * `embedder` is optional (keyword-only recall without it).
 */
export function createSidecar(lib, { stateDir, embedder, recallPool = RECALL_POOL, maxOpen = 32 } = {}) {
  if (!stateDir) throw new Error("createSidecar needs a stateDir");
  mkdirSync(stateDir, { recursive: true });
  /** user_id → { store, retriever, info, used }: the stores held open. */
  const open = new Map();
  /** user_id → { tail, pending }: each user's queue of operations. */
  const queues = new Map();
  const counts = { adds: 0, messagesStored: 0, emptySkipped: 0, undated: 0, searches: 0, searchesUndatedQuestion: 0, deletes: 0, errors: 0 };
  let closed = false;

  const paths = (userId) => {
    const stem = join(stateDir, userFileStem(userId));
    return { db: `${stem}.sqlite`, info: `${stem}.json` };
  };

  /** Close the least recently used stores no queued operation is waiting on, down to `maxOpen`. */
  function evictIdle() {
    if (open.size <= maxOpen) return;
    const idle = [...open.entries()].filter(([id]) => !queues.has(id)).sort((a, b) => a[1].used - b[1].used);
    for (const [id, u] of idle) {
      if (open.size <= maxOpen) break;
      u.store.close?.();
      open.delete(id);
    }
  }

  /** The user's open state; with `create`, a fresh store when there is none. */
  function stateOf(userId, { create }) {
    let u = open.get(userId);
    if (u) return u;
    const p = paths(userId);
    const exists = existsSync(p.info);
    if (!exists && !create) return null;
    const store = new lib.SqliteMemoryStore(p.db);
    const info = exists ? JSON.parse(readFileSync(p.info, "utf8")) : { user_id: userId, latest: null, memories: 0, undated: 0 };
    if (info.user_id !== userId) {
      store.close?.();
      throw new Error(`store file ${p.info} belongs to ${JSON.stringify(info.user_id)}, not ${JSON.stringify(userId)}`);
    }
    if (!exists) writeFileSync(p.info, JSON.stringify(info));
    u = { store, retriever: new lib.HybridRetriever(store, embedder), info, used: Date.now() };
    open.set(userId, u);
    // This user has an operation queued (the caller's), so it is never the one evicted.
    evictIdle();
    return u;
  }

  /** Run `fn` after everything already queued for `userId`; a failure does not block the ones behind it. */
  function serial(userId, fn) {
    if (closed) return Promise.reject(new HttpError(503, "sidecar is closing"));
    let q = queues.get(userId);
    if (!q) {
      q = { tail: Promise.resolve(), pending: 0 };
      queues.set(userId, q);
    }
    q.pending += 1;
    const run = q.tail.then(fn);
    q.tail = run.catch(() => {});
    return run.finally(() => {
      q.pending -= 1;
      if (q.pending === 0 && queues.get(userId) === q) queues.delete(userId);
    });
  }

  async function add(body) {
    const userId = requireUser(body);
    const messages = body.messages;
    if (!Array.isArray(messages)) throw new HttpError(400, "messages must be an array");
    for (const [i, m] of messages.entries()) {
      if (!m || typeof m !== "object" || typeof m.content !== "string") throw new HttpError(400, `messages[${i}] needs a string content`);
    }
    return serial(userId, async () => {
      const u = stateOf(userId, { create: true });
      try {
        let added = 0;
        let skippedEmpty = 0;
        let undated = 0;
        for (const m of messages) {
          const text = m.content.trim();
          if (text === "") {
            skippedEmpty += 1;
            continue;
          }
          const role = m.role === "assistant" ? "assistant" : m.role === "system" ? "system" : "user";
          const at = parseBenchDate(m.chat_time);
          if (!at) undated += 1;
          await u.store.addNode({
            provenance: role === "user" ? "UserInput" : "AIInferred",
            encryptionKeyRef: "omnimemeval",
            memoryType: "Conversation",
            privacyClassification: "Private",
            retentionTier: "FullRetention",
            content: { text },
            contextualMetadata: { role, ...(m.name ? { name: String(m.name) } : {}), ...(at ? { at } : {}), ...(m.chat_time && !at ? { unparsedChatTime: String(m.chat_time).slice(0, 80) } : {}) },
            confidenceWeight: 1,
            decayRate: 0,
            ...(at ? { validFrom: at } : {}),
          });
          added += 1;
          if (at && (!u.info.latest || at > u.info.latest)) u.info.latest = at;
        }
        if (embedder && added) await lib.indexMissingEmbeddings(u.store, embedder);
        u.info.memories += added;
        u.info.undated += undated;
        writeFileSync(paths(userId).info, JSON.stringify(u.info));
        counts.adds += 1;
        counts.messagesStored += added;
        counts.emptySkipped += skippedEmpty;
        counts.undated += undated;
        return { added, skippedEmpty, undated };
      } finally {
        u.used = Date.now();
      }
    });
  }

  async function search(body) {
    const userId = requireUser(body);
    if (typeof body.query !== "string" || body.query.trim() === "") throw new HttpError(400, "query must be a non-empty string");
    const topK = body.top_k ?? 20;
    if (!Number.isInteger(topK) || topK < 1 || topK > 1000) throw new HttpError(400, "top_k must be an integer from 1 to 1000");
    return serial(userId, async () => {
      const u = stateOf(userId, { create: false });
      if (!u) throw new HttpError(404, `no memory for user ${userId}: never added, or deleted`);
      try {
        const asked = parseBenchDate(body.question_date);
        if (body.question_date && !asked) counts.searchesUndatedQuestion += 1;
        const now = asked ?? u.info.latest;
        const t0 = performance.now();
        const hits = await u.retriever.recall(body.query, { limit: Math.max(topK, recallPool), expand: now ? { now } : true });
        const ms = Math.round((performance.now() - t0) * 10) / 10;
        const memories = hits.slice(0, topK).map((node) => {
          const said = node.contextualMetadata ?? {};
          return memoryLine({ text: node.content?.text ?? "", role: said.role ?? "user", name: said.name, at: said.at ?? null });
        });
        counts.searches += 1;
        return { memories, recalled: hits.length, ms, now: now ?? null };
      } finally {
        u.used = Date.now();
      }
    });
  }

  async function remove(body) {
    const userId = requireUser(body);
    return serial(userId, async () => {
      const u = open.get(userId);
      if (u) {
        u.store.close?.();
        open.delete(userId);
      }
      const p = paths(userId);
      const existed = existsSync(p.info);
      for (const f of [p.db, `${p.db}-wal`, `${p.db}-shm`, p.info]) rmSync(f, { force: true });
      counts.deletes += 1;
      return { deleted: existed };
    });
  }

  function stats() {
    return { ...counts, openStores: open.size };
  }

  async function close() {
    closed = true;
    await Promise.allSettled([...queues.values()].map((q) => q.tail));
    for (const u of open.values()) u.store.close?.();
    open.clear();
  }

  return { add, search, remove, stats, close, countError: () => { counts.errors += 1; } };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, `request body over ${MAX_BODY_BYTES} bytes`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
      } catch (e) {
        reject(new HttpError(400, `body is not JSON: ${e.message}`));
      }
    });
    req.on("error", reject);
  });
}

function send(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

/** `/b/<board>/<op>` → `{ board, op }`; a plain `/<op>` is board "default"; null for anything else. */
export function sidecarRoute(url) {
  // A board names a directory: letters, digits, _ and - only (never "." or ".."), led by a letter or digit.
  const m = /^(?:\/b\/([A-Za-z0-9][A-Za-z0-9_-]{0,63}))?\/(add|search|delete|stats)$/.exec(url ?? "");
  return m ? { board: m[1] ?? "default", op: m[2] } : null;
}

/**
 * Serve on 127.0.0.1:`port` (0 = any free port). Each board gets its own
 * sidecar (`sidecarFor(board)`, made on first use), so one board's stores
 * live apart from another's. Resolves to `{ url, close, stats }`.
 */
export function serveSidecar(sidecarFor, { port = 0, health = {}, log = () => {} } = {}) {
  const boards = new Map();
  const get = (board) => {
    if (!boards.has(board)) boards.set(board, sidecarFor(board));
    return boards.get(board);
  };
  const stats = () => Object.fromEntries([...boards].map(([b, s]) => [b, s.stats()]));
  const server = createServer(async (req, res) => {
    let sidecar = null;
    try {
      if (req.method === "GET" && req.url === "/health") return send(res, 200, { ok: true, ...health });
      if (req.method === "GET" && req.url === "/stats") return send(res, 200, stats());
      const route = sidecarRoute(req.url);
      if (!route || (route.op === "stats" ? req.method !== "GET" : req.method !== "POST")) throw new HttpError(404, `no route ${req.method} ${req.url}`);
      sidecar = get(route.board);
      if (route.op === "stats") return send(res, 200, sidecar.stats());
      const op = { add: sidecar.add, search: sidecar.search, delete: sidecar.remove }[route.op];
      send(res, 200, await op(await readBody(req)));
    } catch (e) {
      sidecar?.countError();
      const status = e instanceof HttpError ? e.status : 500;
      if (status >= 500) log(`error on ${req.url}: ${e?.stack ?? e}`);
      send(res, status, { error: e?.message ?? String(e) });
    }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const { port: bound } = server.address();
      resolve({
        url: `http://127.0.0.1:${bound}`,
        stats,
        close: () => new Promise((done) => server.close(() => Promise.all([...boards.values()].map((s) => s.close())).then(() => done()))),
      });
    });
  });
}

/** Load the built library and (for hybrid retrieval) warm the on-device embedder. */
export async function loadLibrary(repoRoot, { retrieval = "hybrid", modelCache } = {}) {
  const distEntry = join(repoRoot, "dist", "index.js");
  if (!existsSync(distEntry)) throw new Error("dist/ is missing: run `npm run build` first (the benchmark measures the built package)");
  const lib = await import(pathToFileURL(distEntry).href);
  if (retrieval === "keyword") return { lib, embedder: undefined };
  if (retrieval !== "hybrid") throw new Error(`--retrieval must be hybrid or keyword, not ${retrieval}`);
  const embedder = new lib.LocalEmbedder(modelCache ? { cacheDir: modelCache } : {});
  try {
    await embedder.embed(["warm-up"]);
  } catch (e) {
    throw new Error(`hybrid retrieval needs the on-device embedder (optional dependency @huggingface/transformers, and a one-time model download): ${e.message}`);
  }
  return { lib, embedder };
}

async function main() {
  const { values: args } = parseArgs({
    options: {
      port: { type: "string", default: "8765" },
      "state-dir": { type: "string" },
      retrieval: { type: "string", default: "hybrid" },
      "model-cache": { type: "string" },
    },
  });
  if (!args["state-dir"]) throw new Error("--state-dir is required");
  const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
  const { lib, embedder } = await loadLibrary(repoRoot, { retrieval: args.retrieval, modelCache: args["model-cache"] });
  const served = await serveSidecar((board) => createSidecar(lib, { stateDir: join(args["state-dir"], board), embedder }), { port: Number(args.port), health: { retrieval: args.retrieval, embedder: embedder?.model ?? null }, log: (m) => console.error(m) });
  console.log(`al-buddy sidecar on ${served.url} (state ${args["state-dir"]}, ${args.retrieval})`);
  const stop = () => served.close().then(() => process.exit(0));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e?.message ?? e);
    process.exit(1);
  });
}
