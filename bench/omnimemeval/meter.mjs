/**
 * Every reader and judge call OmniMemEval makes goes through this local,
 * OpenAI-compatible endpoint (`ANSWER_BASE_URL` / `EVAL_BASE_URL`), which
 * prices it, keeps a ledger per board and model, and enforces a hard spend
 * cap. In `stub` mode it answers itself and nothing leaves the machine (the
 * dry run); in `forward` mode it passes the call to OpenAI with the key only
 * it holds — the harness gets a placeholder key.
 *
 * The cap is hard: before a call is forwarded, its worst case is reserved —
 * every byte of the prompt counted as a token (a BPE token is never shorter
 * than a byte) and the model's whole output limit — and a call whose worst
 * case does not fit under the cap, beside what is spent and reserved, is
 * refused with HTTP 402. OmniMemEval does not retry a 402, so the stage
 * stops there. A reservation is replaced by the call's own `usage` when it
 * returns; a call that returns no usage is charged its worst case.
 *
 * Prices are OpenAI's Standard-tier list prices per million tokens as this
 * file was written (2026-11-18; not re-checked online from the job's
 * sandbox). A model not in the table is refused: a call that cannot be
 * priced cannot be capped.
 */
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";

export const PRICES = Object.freeze({
  "gpt-4.1-mini": { input: 0.4, cachedInput: 0.1, output: 1.6, maxOutput: 32_768 },
  "gpt-4o-mini": { input: 0.15, cachedInput: 0.075, output: 0.6, maxOutput: 16_384 },
});

/** The price row for `model`: exact, or by its family name with the dated suffix dropped. */
export function priceOf(model) {
  if (typeof model !== "string") return null;
  if (PRICES[model]) return PRICES[model];
  const family = model.replace(/-\d{4}-\d{2}-\d{2}$/, "");
  return PRICES[family] ?? null;
}

/** USD for one call's `usage` (cached prompt tokens at the cached rate). */
export function costUsd(model, usage) {
  const p = priceOf(model);
  if (!p) throw new Error(`no price for model ${model}`);
  const prompt = Number(usage?.prompt_tokens ?? 0);
  const cached = Math.min(prompt, Number(usage?.prompt_tokens_details?.cached_tokens ?? 0));
  const completion = Number(usage?.completion_tokens ?? 0);
  return ((prompt - cached) * p.input + cached * p.cachedInput + completion * p.output) / 1e6;
}

function messageText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c) => (typeof c === "string" ? c : (c?.text ?? JSON.stringify(c)))).join("\n");
  return content == null ? "" : JSON.stringify(content);
}

/** The prompt's bytes: an upper bound on its tokens. Plus a few per message for the chat framing. */
export function promptBytes(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  let bytes = 3;
  for (const m of messages) bytes += 4 + Buffer.byteLength(String(m?.role ?? "")) + Buffer.byteLength(messageText(m?.content));
  return bytes;
}

/** A rough token count for English text (about four characters a token), for the stub's `usage`. */
export function approxTokens(text) {
  return Math.ceil(text.length / 4);
}

/** The most `body` can cost: every prompt byte a token, every choice at the model's whole output limit (or the request's own max). */
export function worstCaseUsd(body) {
  const p = priceOf(body?.model);
  if (!p) throw new Error(`no price for model ${body?.model}`);
  const asked = Number(body.max_completion_tokens ?? body.max_tokens ?? p.maxOutput);
  const perChoice = Math.min(Number.isFinite(asked) && asked > 0 ? asked : p.maxOutput, p.maxOutput);
  const n = Math.max(1, Number(body.n ?? 1));
  return (promptBytes(body) * p.input + perChoice * n * p.output) / 1e6;
}

/**
 * The ledger and the cap, without the HTTP. `reserve` returns a ticket or
 * null (refused); `settle` replaces a ticket by what the call cost.
 */
export class SpendLedger {
  constructor({ capUsd, mode, ledgerPath = null }) {
    if (!(capUsd > 0)) throw new Error("capUsd must be above 0");
    this.capUsd = capUsd;
    this.mode = mode;
    this.ledgerPath = ledgerPath;
    this.spentUsd = 0;
    this.reservedUsd = 0;
    this.boards = {};
    this.tripped = null;
    this.nextTicket = 1;
    this.tickets = new Map();
  }

  row(board, model) {
    const b = (this.boards[board] ??= {});
    return (b[model] ??= { calls: 0, promptTokens: 0, cachedTokens: 0, completionTokens: 0, usd: 0, refused: 0, upstreamErrors: 0, usageMissing: 0 });
  }

  /** A ticket for `body`'s worst case on `board`, or null when it does not fit under the cap (and the cap is marked tripped). */
  reserve(body, board = "unassigned") {
    const worst = worstCaseUsd(body);
    if (this.spentUsd + this.reservedUsd + worst > this.capUsd) {
      this.row(board, body.model).refused += 1;
      this.tripped ??= { at: new Date().toISOString(), board, spentUsd: this.spentUsd, reservedUsd: this.reservedUsd, refusedCallWorstCaseUsd: worst };
      this.save();
      return null;
    }
    const id = this.nextTicket++;
    this.tickets.set(id, { worst, model: body.model, board });
    this.reservedUsd += worst;
    return id;
  }

  /** `outcome`: `{ usage }` for a call that returned, `{ upstreamError: true }` for one OpenAI refused (not billed), `{ lost: true }` for one whose fate is unknown (charged its worst case). */
  settle(id, outcome) {
    const t = this.tickets.get(id);
    if (!t) throw new Error(`no reservation ${id}`);
    this.tickets.delete(id);
    this.reservedUsd = Math.max(0, this.reservedUsd - t.worst);
    const r = this.row(t.board, t.model);
    let usd = 0;
    if (outcome.upstreamError) r.upstreamErrors += 1;
    else if (outcome.usage) {
      usd = costUsd(t.model, outcome.usage);
      r.calls += 1;
      r.promptTokens += Number(outcome.usage.prompt_tokens ?? 0);
      r.cachedTokens += Number(outcome.usage.prompt_tokens_details?.cached_tokens ?? 0);
      r.completionTokens += Number(outcome.usage.completion_tokens ?? 0);
    } else {
      usd = t.worst;
      r.calls += 1;
      r.usageMissing += 1;
    }
    r.usd += usd;
    this.spentUsd += usd;
    this.save();
    return usd;
  }

  /** Per board: calls, tokens and USD summed over its models. */
  boardTotals(board) {
    const t = { calls: 0, promptTokens: 0, completionTokens: 0, usd: 0, refused: 0, upstreamErrors: 0, usageMissing: 0, byModel: this.boards[board] ?? {} };
    for (const r of Object.values(t.byModel)) for (const k of ["calls", "promptTokens", "completionTokens", "usd", "refused", "upstreamErrors", "usageMissing"]) t[k] += r[k];
    return t;
  }

  snapshot() {
    return { mode: this.mode, capUsd: this.capUsd, spentUsd: this.spentUsd, billedUsd: this.mode === "stub" ? 0 : this.spentUsd, reservedUsd: this.reservedUsd, tripped: this.tripped, boards: this.boards, prices: PRICES };
  }

  save() {
    if (this.ledgerPath) writeFileSync(this.ledgerPath, `${JSON.stringify(this.snapshot(), null, 2)}\n`);
  }
}

/** The stub's reply: the reader says it was not called; the judge returns a parseable WRONG for every OmniMemEval judge format. */
export function stubContent(body, { answerModel }) {
  if (body.model === answerModel) return "(a) stub reader: no model was called.";
  // Two objects: nlp_metrics.extract_label_json wants {"label": ...} alone; BEAM's rubric
  // regex wants "score", and its ordering regex wants "positions": [...] to close an object.
  return '{"label": "WRONG"}\n{"score": 0, "reason": "stub judge: no model was called", "positions": []}';
}

function send(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

/** `/b/<board>/v1/chat/completions` → `{ board }`; plain `/v1/chat/completions` → board "unassigned"; anything else null. */
export function chatRoute(url) {
  if (url === "/v1/chat/completions") return { board: "unassigned" };
  const m = /^\/b\/([A-Za-z0-9][A-Za-z0-9_-]{0,63})\/v1\/chat\/completions$/.exec(url ?? "");
  return m ? { board: m[1] } : null;
}

/**
 * Serve the meter on 127.0.0.1:`port`. `mode`: "stub" or "forward" (needs
 * `apiKey`). `fetchImpl` is for tests. Resolves to `{ url, ledger, close }`;
 * a board's base URL is `${url}/b/<board>/v1`, so the ledger keeps each
 * board's calls apart.
 */
export function serveMeter({ mode, capUsd, apiKey, answerModel, upstream = "https://api.openai.com/v1", ledgerPath = null, port = 0, fetchImpl = fetch, timeoutMs = 600_000 }) {
  if (mode !== "stub" && mode !== "forward") throw new Error(`mode must be stub or forward, not ${mode}`);
  if (mode === "forward" && !apiKey) throw new Error("forward mode needs an API key");
  const ledger = new SpendLedger({ capUsd, mode, ledgerPath });
  ledger.save();
  const server = createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/meter") return send(res, 200, ledger.snapshot());
      const route = req.method === "POST" ? chatRoute(req.url) : null;
      if (!route) return send(res, 404, { error: { message: `no route ${req.method} ${req.url}`, type: "invalid_request_error" } });
      const body = await readJson(req);
      if (body.stream) return send(res, 400, { error: { message: "the meter does not pass streamed calls: their usage cannot be capped", type: "invalid_request_error" } });
      if (!priceOf(body.model)) return send(res, 400, { error: { message: `the meter has no price for model ${body.model}, so it cannot cap it`, type: "invalid_request_error" } });
      const ticket = ledger.reserve(body, route.board);
      if (ticket === null) {
        return send(res, 402, { error: { message: `spend cap of $${capUsd} reached ($${ledger.spentUsd.toFixed(4)} spent): call refused`, type: "spend_cap_reached", code: "spend_cap" } });
      }
      if (mode === "stub") {
        const content = stubContent(body, { answerModel });
        const usage = { prompt_tokens: Math.ceil((promptBytes(body) - 3) / 4) + 3, completion_tokens: approxTokens(content) };
        usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
        ledger.settle(ticket, { usage });
        return send(res, 200, { id: `stub-${Date.now()}`, object: "chat.completion", created: Math.floor(Date.now() / 1000), model: body.model, choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }], usage });
      }
      let upstreamRes;
      let text;
      try {
        upstreamRes = await fetchImpl(`${upstream}/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
        text = await upstreamRes.text();
      } catch (e) {
        // The request may have reached OpenAI: charge its worst case, and let the harness retry.
        ledger.settle(ticket, { lost: true });
        return send(res, 504, { error: { message: `upstream call failed: ${e?.message ?? e}`, type: "upstream_error" } });
      }
      if (!upstreamRes.ok) {
        ledger.settle(ticket, { upstreamError: true });
        res.writeHead(upstreamRes.status, { "Content-Type": upstreamRes.headers.get("content-type") ?? "application/json", ...(upstreamRes.headers.get("retry-after") ? { "Retry-After": upstreamRes.headers.get("retry-after") } : {}) });
        return res.end(text);
      }
      let parsed = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
      ledger.settle(ticket, parsed?.usage ? { usage: parsed.usage } : { lost: true });
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(text);
    } catch (e) {
      return send(res, 500, { error: { message: e?.message ?? String(e), type: "meter_error" } });
    }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const { port: bound } = server.address();
      resolve({ url: `http://127.0.0.1:${bound}`, ledger, close: () => new Promise((done) => server.close(() => done())) });
    });
  });
}
