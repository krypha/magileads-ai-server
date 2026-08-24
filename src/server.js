/**
 * Groleads AI Assistant — standalone streaming server.
 *
 * Same behaviour as the Next.js route /api/ai/chat, but usable from ANY front-end.
 * Runs on Bun or Node 18+ (zero dependencies, uses node:http + global fetch).
 *
 *   POST /ai/chat   -> SSE stream (text deltas + tool events)
 *   GET  /health    -> { ok: true }
 *   GET  /ai/meta   -> tool labels (handy for the front-end indicator)
 *
 * AUTH — the caller sends its OWN Magileads credentials:
 *   Authorization: Bearer <magileads access_token>   (what the React app already has)
 *   or  X-API-Key: <magileads api key>
 * Those credentials are used ONLY to execute tools server-side. They are NEVER put
 * in the model context, and the assistant can only ever see that user's data.
 *
 * This server does NOT refresh tokens: the React front already owns that logic
 * (axios interceptor + Web Locks). If the token is expired we answer 401 with
 * { state_message: "token_expired" } so the caller refreshes and retries.
 */

import http from "node:http";
import { getMe } from "./magileads.js";
import { AI_TOOLS, TOOL_LABELS, CREATES_LIST, executeTool } from "./tools.js";
import { buildSystemPrompt } from "./prompt.js";

const PORT = Number(process.env.PORT) || 8787;
const AI_API_URL = (process.env.AI_API_URL || "https://openrouter.ai/api/v1").replace(/\/+$/, "");
const AI_API_KEY = process.env.AI_API_KEY;
const AI_MODEL = process.env.AI_MODEL;
const AI_MODEL_COMPLEX = process.env.AI_MODEL_COMPLEX;

// "*" allows any origin (dev). In production list your front origins, comma-separated.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "*")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const MAX_MESSAGES = 50;
const MAX_CONTENT = 16_000;
const MAX_ROUNDS = 6; // tool round-trips before we stop looping
const CALL_TIMEOUT_MS = 120_000;
const MAX_BODY_BYTES = 1_000_000;
const RATE_LIMIT_PER_MIN = Number(process.env.RATE_LIMIT_PER_MIN) || 20;

/* --------------------------------- helpers -------------------------------- */

function corsHeaders(origin) {
  const allow =
    ALLOWED_ORIGINS.includes("*") || !origin
      ? origin || "*"
      : ALLOWED_ORIGINS.includes(origin)
        ? origin
        : null;
  if (!allow) return null; // origin not allowed
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Key",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function json(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    ...extraHeaders,
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("payload_too_large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        resolve({});
      }
    });
    req.on("error", reject);
  });
}

/** Credentials of the CALLER (never a shared/global account). */
function readAuth(req) {
  const authz = req.headers["authorization"];
  const apiKey = req.headers["x-api-key"];
  if (typeof authz === "string" && /^Bearer\s+/i.test(authz)) {
    return { accessToken: authz.replace(/^Bearer\s+/i, "").trim() };
  }
  if (typeof apiKey === "string" && apiKey.trim()) return { apiKey: apiKey.trim() };
  return null;
}

// Very small in-memory limiter (per user id). Enough to stop a runaway loop from
// burning model credits; use a shared store if you run several instances.
const hits = new Map();
function rateLimited(key) {
  const now = Date.now();
  const win = 60_000;
  const arr = (hits.get(key) || []).filter((t) => now - t < win);
  arr.push(now);
  hits.set(key, arr);
  if (hits.size > 5000) hits.clear(); // crude memory guard
  return arr.length > RATE_LIMIT_PER_MIN;
}

/* ------------------------------ the SSE chat ------------------------------ */

async function handleChat(req, res, cors) {
  if (!AI_API_KEY || !AI_MODEL) {
    return json(res, 503, { ok: false, errorKey: "ai_not_configured" }, cors);
  }

  const auth = readAuth(req);
  if (!auth) return json(res, 401, { ok: false, errorKey: "missing_credentials" }, cors);

  let body;
  try {
    body = await readBody(req);
  } catch {
    return json(res, 413, { ok: false, errorKey: "payload_too_large" }, cors);
  }

  // Validate the caller AND get the authoritative identity in one call.
  const me = await getMe(auth);
  if (!me.ok) {
    // Let the caller's own refresh logic kick in (their axios interceptor retries
    // on token_expired), instead of duplicating token refresh here.
    return json(
      res,
      me.status === 0 ? 502 : me.status || 401,
      { ok: false, state_message: me.errorKey || "unauthorized" },
      cors,
    );
  }
  const profile = me.data?.user_profile ?? me.data ?? {};

  if (rateLimited(String(profile.id ?? profile.email ?? "anon"))) {
    return json(res, 429, { ok: false, errorKey: "rate_limited" }, cors);
  }

  // Accept ONLY user/assistant turns, projected to {role, content}: a client must
  // never be able to smuggle a system/tool turn and override the instructions.
  const clientMessages = (Array.isArray(body.messages) ? body.messages : [])
    .filter(
      (m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string",
    )
    .slice(-MAX_MESSAGES)
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_CONTENT) }));
  if (!clientMessages.length) return json(res, 400, { ok: false, errorKey: "empty" }, cors);

  // The user-facing tier ("simple" | "complex") maps to a real model HERE, so the
  // model name is never exposed to the client.
  const model = body.tier === "complex" ? AI_MODEL_COMPLEX || AI_MODEL : AI_MODEL;

  const convo = [{ role: "system", content: buildSystemPrompt(profile) }, ...clientMessages];

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no", // don't let nginx buffer the stream
    ...cors,
  });

  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  const sendEvent = (event, obj) => res.write(`event: ${event}\ndata: ${JSON.stringify(obj)}\n\n`);
  const sendText = (text) => send({ choices: [{ delta: { content: text } }] });

  const ac = new AbortController();
  let closed = false;
  req.on("close", () => {
    closed = true;
    ac.abort();
  });

  try {
    for (let round = 0; round < MAX_ROUNDS && !closed; round++) {
      let upstream;
      const timeout = setTimeout(() => ac.abort(), CALL_TIMEOUT_MS);
      try {
        upstream = await fetch(`${AI_API_URL}/chat/completions`, {
          method: "POST",
          headers: { Authorization: `Bearer ${AI_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model,
            messages: convo,
            tools: AI_TOOLS,
            tool_choice: "auto",
            stream: true,
          }),
          signal: ac.signal,
        });
      } catch {
        clearTimeout(timeout);
        if (!closed) sendText("\n\n_(Le service IA est injoignable pour le moment.)_");
        break;
      }
      clearTimeout(timeout);

      if (!upstream.ok || !upstream.body) {
        const detail = await upstream.text().catch(() => "");
        console.error(`[ai] upstream ${upstream.status}: ${detail.slice(0, 400)}`);
        sendText("\n\n_(Erreur du service IA.)_");
        break;
      }

      // Parse the provider's SSE: forward text deltas, accumulate tool calls.
      const reader = upstream.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      let assistantContent = "";
      const toolCalls = [];

      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          const l = line.trim();
          if (!l.startsWith("data:")) continue;
          const data = l.slice(5).trim();
          if (!data || data === "[DONE]") continue;
          let j;
          try {
            j = JSON.parse(data);
          } catch {
            continue;
          }
          const delta = j.choices?.[0]?.delta;
          if (!delta) continue;
          if (typeof delta.content === "string" && delta.content) {
            assistantContent += delta.content;
            sendText(delta.content);
          }
          for (const tc of delta.tool_calls ?? []) {
            const idx = tc.index ?? 0;
            if (!toolCalls[idx]) toolCalls[idx] = { id: "", name: "", args: "" };
            const slot = toolCalls[idx];
            if (tc.id) slot.id = tc.id;
            if (tc.function?.name) slot.name = tc.function.name;
            if (tc.function?.arguments) slot.args += tc.function.arguments;
          }
        }
      }

      const calls = toolCalls.filter((c) => c && c.name);
      if (!calls.length) break; // the model produced its final answer

      convo.push({
        role: "assistant",
        content: assistantContent || null,
        tool_calls: calls.map((c) => ({
          id: c.id,
          type: "function",
          function: { name: c.name, arguments: c.args || "{}" },
        })),
      });

      for (const c of calls) {
        if (closed) break;
        sendEvent("tool.progress", {
          tool: c.name,
          label: TOOL_LABELS[c.name] || c.name.replace(/_/g, " "),
          status: "running",
          creates_list: CREATES_LIST.includes(c.name),
        });
        const result = await executeTool(c.name, c.args, auth);
        sendEvent("tool.progress", {
          tool: c.name,
          label: TOOL_LABELS[c.name] || c.name.replace(/_/g, " "),
          status: "completed",
          creates_list: CREATES_LIST.includes(c.name),
        });

        // The clickable LinkedIn account card is built from the REAL tool result
        // here (server-side) — never from the model's text, so it cannot invent
        // accounts.
        if (c.name === "ask_linkedin_account") {
          try {
            const parsed = JSON.parse(result);
            if (Array.isArray(parsed.accounts) && parsed.accounts.length) {
              sendEvent("linkedin.accounts", { accounts: parsed.accounts });
            }
          } catch {
            /* ignore */
          }
        }
        convo.push({ role: "tool", tool_call_id: c.id, content: result });
      }
    }
    if (!closed) res.write("data: [DONE]\n\n");
  } catch (err) {
    console.error("[ai] stream error:", err?.message || err);
  } finally {
    if (!closed) res.end();
  }
}

/* --------------------------------- routing -------------------------------- */

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  const cors = corsHeaders(origin);
  if (!cors) return json(res, 403, { ok: false, errorKey: "origin_not_allowed" });

  if (req.method === "OPTIONS") {
    res.writeHead(204, cors);
    return res.end();
  }

  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (req.method === "GET" && url.pathname === "/health") {
    return json(res, 200, { ok: true, configured: Boolean(AI_API_KEY && AI_MODEL) }, cors);
  }

  if (req.method === "GET" && url.pathname === "/ai/meta") {
    return json(res, 200, { ok: true, toolLabels: TOOL_LABELS, createsList: CREATES_LIST }, cors);
  }

  if (req.method === "POST" && url.pathname === "/ai/chat") {
    return handleChat(req, res, cors);
  }

  return json(res, 404, { ok: false, errorKey: "not_found" }, cors);
});

server.listen(PORT, () => {
  console.log(`[ai-server] listening on http://localhost:${PORT}`);
  console.log(`[ai-server] model(simple)=${AI_MODEL || "(unset)"} model(complex)=${AI_MODEL_COMPLEX || "(= simple)"}`);
  if (!AI_API_KEY || !AI_MODEL) console.warn("[ai-server] WARNING: AI_API_KEY / AI_MODEL not set → /ai/chat returns 503");
});
