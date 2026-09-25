import { cardsForTool, changesData } from './cards.js';
/**
 * Magileads AI Assistant — standalone streaming server.
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
 * Those credentials read the caller's OpenAI integration from Magileads and
 * execute tools server-side. They are NEVER put in the model context.
 *
 * This server does NOT refresh tokens: the React front already owns that logic
 * (axios interceptor + Web Locks). If the token is expired we answer 401 with
 * { state_message: "token_expired" } so the caller refreshes and retries.
 */

import http from "node:http";
import { getMe, listOpenAiIntegrations } from "./magileads.js";
import { AI_TOOLS, TOOL_LABELS, CREATES_LIST, executeTool } from "./tools.js";
import { buildSystemPrompt } from "./prompt.js";
import { MODEL_PROVIDERS, readModelStream, resolveModels, upstreamRequest } from './model-providers.js';
import { approvedRunTool, approvedToolArgs, parseImportApproval } from './import-approval.js';
import { checkIncludedBudget, sharedPromptTooLarge } from './included-budget.js';
import { redactHiddenAuditText } from './assistant-policy.js';

const PORT = Number(process.env.PORT) || 8787;
const AI_API_KEY = process.env.AI_API_KEY;
const AI_MODEL = process.env.AI_MODEL;
const AI_MODEL_COMPLEX = process.env.AI_MODEL_COMPLEX;
const ALLOW_CUSTOM_MODEL = process.env.ALLOW_CUSTOM_MODEL !== "false";

/** Statuts upstream pour lesquels un autre modèle candidat vaut le coup. */
const RETRIABLE_UPSTREAM = [402, 404, 429, 502, 503];

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
const IMPORT_CONTEXT_PREFIX = '[Contexte : je suis sur la page de création de liste';
const IMPORT_READ_TOOLS = new Set([
  'update_targeting', 'count_database_targeting', 'ask_linkedin_account',
  'list_contact_lists', 'get_contact_list', 'list_linkedin_accounts', 'get_account_overview',
]);
const IMPORT_ONLY_TOOLS = new Set([
  'update_targeting', 'count_database_targeting', 'run_database_targeting', 'run_sales_navigator_targeting',
]);

function explicitImportApproval(messages, submitted) {
  const users = messages.filter(message => message.role === 'user');
  if (users.length < 2 || !messages.slice(0, -1).some(message => message.role === 'assistant')) return null;
  const last = messages.at(-1);
  if (last?.role !== 'user') return null;
  // The UI sends the reviewed destination and criteria independently of the
  // translated text. The server checks and enforces every supported field.
  if (submitted != null) return parseImportApproval(submitted);
  const text = last.content.trim();
  if (!/^(?:(?:oui|ok|d'accord)[,!.\s]+)?(?:je\s+)?(?:valide\b|go\b|c['’]est bon\b|la cible me convient\b)/i.test(text)) return null;
  if (/^(?:je\s+)?valide\s+pas\b|^(?:non|pas maintenant)\b/i.test(text)) return null;
  const name = text.match(/\bliste\s+[«"]([^»"]+)[»"]/i)?.[1]?.trim() ?? null;
  return { name, listId: null, criteria: null, filters: null, accountId: null };
}

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

/**
 * Credentials of the CALLER (never a shared/global account).
 *
 * Both headers are kept when both are sent: the React app pairs
 * `Authorization: Bearer <main token>` with `X-API-Key: <switched-account token>`
 * when the user switched accounts. We forward the pair to Magileads so the
 * assistant always acts on the SAME account as the rest of the app.
 */
function readAuth(req) {
  const authz = req.headers["authorization"];
  const apiKey = req.headers["x-api-key"];
  const auth = {};
  if (typeof authz === "string" && /^Bearer\s+/i.test(authz)) {
    auth.accessToken = authz.replace(/^Bearer\s+/i, "").trim();
  }
  if (typeof apiKey === "string" && apiKey.trim()) auth.apiKey = apiKey.trim();
  return auth.accessToken || auth.apiKey ? auth : null;
}

async function authenticate(req, res, cors) {
  const auth = readAuth(req);
  if (!auth) {
    json(res, 401, { ok: false, errorKey: 'missing_credentials' }, cors);
    return null;
  }
  const me = await getMe(auth);
  if (!me.ok) {
    json(res, me.status === 0 ? 502 : me.status || 401,
      { ok: false, state_message: me.errorKey || 'unauthorized' }, cors);
    return null;
  }
  const profile = me.data?.user_profile ?? me.data ?? {};
  const accountId = Number(profile.id);
  if (!Number.isSafeInteger(accountId) || accountId <= 0) {
    json(res, 502, { ok: false, errorKey: 'account_id_unavailable' }, cors);
    return null;
  }
  return { auth, profile, accountId };
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
  let body;
  try {
    body = await readBody(req);
  } catch {
    return json(res, 413, { ok: false, errorKey: "payload_too_large" }, cors);
  }

  // Never trust an account id supplied by the browser: the provider key is
  // selected using the authoritative identity returned by Magileads.
  const caller = await authenticate(req, res, cors);
  if (!caller) return;
  const { auth, profile, accountId } = caller;

  if (body.mode != null && body.mode !== 'chat' && body.mode !== 'import') {
    return json(res, 400, { ok: false, errorKey: 'invalid_mode' }, cors);
  }

  if (rateLimited(String(accountId))) {
    return json(res, 429, { ok: false, errorKey: "rate_limited" }, cors);
  }

  // Accept ONLY user/assistant turns, projected to {role, content}: a client must
  // never be able to smuggle a system/tool turn and override the instructions.
  const allMessages = (Array.isArray(body.messages) ? body.messages : [])
    .filter(
      (m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string",
    )
    .map((m) => ({ role: m.role, content: (m.role === 'assistant'
      ? redactHiddenAuditText(m.content) : m.content).slice(0, MAX_CONTENT) }));
  const importMode = body.mode === 'import' || allMessages.find(message => message.role === 'user')?.content.startsWith(IMPORT_CONTEXT_PREFIX);
  const clientMessages = allMessages.slice(-MAX_MESSAGES);
  if (!clientMessages.length) return json(res, 400, { ok: false, errorKey: "empty" }, cors);
  // The current import UI has a separate review form. A typed "go" is not its
  // final confirmation; legacy clients without an explicit mode keep their
  // historical text approval for compatibility.
  const approval = importMode && (body.mode !== 'import' || body.import_approval != null)
    ? explicitImportApproval(allMessages, body.import_approval) : null;
  if (body.import_approval != null && !approval) {
    return json(res, 400, { ok: false, errorKey: 'invalid_import_approval' }, cors);
  }
  if (approval?.criteria) {
    clientMessages.at(-1).content += `\n\nCritères confirmés dans le formulaire : ${JSON.stringify(approval.criteria)}. Utilise uniquement la source et les valeurs confirmées.`;
  }

  // The user-facing tier maps to real model(s) HERE.
  const provider = body.provider ?? 'openrouter';
  if (!MODEL_PROVIDERS.includes(provider)) {
    return json(res, 400, { ok: false, errorKey: 'invalid_provider' }, cors);
  }
  // A regular user cannot bypass the included tier with a forged client body.
  const tier = profile.level === 'user' ? 'simple'
    : ["free", "simple", "complex", "custom"].includes(body.tier) ? body.tier : "simple";
  if (provider !== 'openrouter' && tier === 'free') {
    return json(res, 400, { ok: false, errorKey: 'paid_provider_has_no_free_tier' }, cors);
  }
  const included = profile.level === 'user' && provider === 'openrouter';
  if (included && sharedPromptTooLarge(clientMessages)) {
    return json(res, 413, { ok: false, errorKey: 'shared_prompt_too_large' }, cors);
  }
  let candidates = resolveModels(provider, tier, body.model);
  let candidateKeys = null;
  let candidateTiers = null;
  let budgetFallback = false;
  if (included) {
    const paidKey = process.env.AI_INCLUDED_API_KEY || AI_API_KEY;
    const freeKey = process.env.AI_API_KEY_FREE || AI_API_KEY || paidKey;
    const freeModels = resolveModels('openrouter', 'free');
    const paidAvailable = await checkIncludedBudget(paidKey);
    budgetFallback = !paidAvailable;
    const paidModels = paidAvailable ? [process.env.AI_MODEL_INCLUDED || 'deepseek/deepseek-v4-flash'] : [];
    candidates = [...paidModels, ...freeModels];
    candidateKeys = [...paidModels.map(() => paidKey), ...freeModels.map(() => freeKey)];
    candidateTiers = [...paidModels.map(() => 'simple'), ...freeModels.map(() => 'free')];
  }
  if (!candidates.length || (included && !candidateKeys?.some(Boolean))) {
    return json(
      res,
      tier === "custom" ? 400 : 503,
      {
        ok: false,
        errorKey: tier === "custom" ? "invalid_custom_model" : "ai_not_configured",
      },
      cors,
    );
  }

  let providerKey = AI_API_KEY;
  if (provider === 'openai') {
    // Magileads remains the only credential store. Resolve the authenticated
    // account's integration afresh for every chat; never persist or cache it.
    const integrations = await listOpenAiIntegrations(auth);
    if (!integrations.ok) return json(res, 502, { ok: false, errorKey: 'integration_unavailable' }, cors);
    if (!integrations.integrations.length) return json(res, 412, { ok: false, errorKey: 'provider_key_missing' }, cors);
    const selectedId = body.openai_key_id;
    if (selectedId != null && (!Number.isSafeInteger(selectedId) || selectedId <= 0)) {
      return json(res, 400, { ok: false, errorKey: 'invalid_openai_key_id' }, cors);
    }
    if (selectedId == null && integrations.integrations.length > 1) {
      return json(res, 409, { ok: false, errorKey: 'openai_key_selection_required' }, cors);
    }
    const selected = selectedId == null
      ? integrations.integrations[0]
      : integrations.integrations.find((item) => item.id === selectedId);
    if (!selected) return json(res, 412, { ok: false, errorKey: 'selected_openai_key_unavailable' }, cors);
    providerKey = selected.key;
  } else if (!providerKey && !included) {
    return json(res, 503, { ok: false, errorKey: 'ai_not_configured' }, cors);
  }

  const convo = [{ role: "system", content: buildSystemPrompt(profile, { mode: importMode ? 'import' : 'chat' }) },
    ...(body.mode === 'import' ? [{ role: 'system', content: 'Cette interface utilise un formulaire de confirmation distinct après la proposition de cible. Un simple « go » écrit dans le chat ne lance rien : invite l’utilisateur à ouvrir « Vérifier la cible » puis à confirmer. Seul le clic final autorise un outil run_*.' }] : []),
    ...clientMessages];

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
  res.on("close", () => {
    closed = true;
    ac.abort();
  });

  // Index du modèle candidat en cours : on n'avance QUE sur un échec récupérable,
  // et le modèle retenu est conservé pour les tours suivants de la conversation.
  let modelIdx = 0;
  let announced = false;
  let produced = false; // texte OU appel d'outil -> sert a detecter un modele muet
  let failed = false;
  let launchAttempted = false;
  let targetingReady = false;

  /** Ouvre le flux upstream, en basculant sur le candidat suivant si besoin. */
  async function openUpstream(round) {
    while (modelIdx < candidates.length) {
      const model = candidates[modelIdx];
      const timeout = setTimeout(() => ac.abort(), CALL_TIMEOUT_MS);
      let upstream;
      try {
        const availableTools = !importMode
          ? AI_TOOLS.filter(tool => !IMPORT_ONLY_TOOLS.has(tool.function.name))
          : AI_TOOLS.filter(tool => IMPORT_READ_TOOLS.has(tool.function.name) ||
            (approval && targetingReady && !launchAttempted && CREATES_LIST.includes(tool.function.name) &&
              (!approvedRunTool(approval) || tool.function.name === approvedRunTool(approval))));
        const toolChoice = importMode && round === 0
          ? { type: 'function', function: { name: 'update_targeting' } }
          : 'auto';
        const request = upstreamRequest(provider, candidateKeys?.[modelIdx] || providerKey, model, convo, ac.signal,
          { tools: availableTools, toolChoice, maxTokens: included ? 2_048 : undefined });
        upstream = await fetch(request.url, request.options);
      } catch {
        clearTimeout(timeout);
        return { error: "unreachable" };
      }
      clearTimeout(timeout);

      if (upstream.ok && upstream.body) return { upstream, model };

      await upstream.body?.cancel().catch(() => undefined);
      // Provider errors can echo account metadata. Never log response bodies.
      console.error(`[ai] upstream ${provider} ${upstream.status} (${model})`);
      // Modèle disparu / saturé / payant : on tente le candidat suivant s'il y en a.
      if (RETRIABLE_UPSTREAM.includes(upstream.status) && modelIdx + 1 < candidates.length) {
        modelIdx++;
        continue;
      }
      return { error: "upstream", status: upstream.status };
    }
    return { error: "no_model" };
  }

  try {
    for (let round = 0; round < MAX_ROUNDS && !closed; round++) {
      const opened = await openUpstream(round);
      if (opened.error) {
        if (!closed) {
          failed = true;
          sendEvent('assistant.error', {
            code: provider !== 'openrouter' && [401, 403].includes(opened.status)
              ? 'provider_key_invalid'
              : 'provider_unavailable',
          });
        }
        break;
      }
      const { upstream, model } = opened;

      // On annonce le modèle réellement utilisé (utile pour les paliers "free"
      // — où l'on peut avoir basculé — et "custom").
      if (!announced) {
        announced = true;
        sendEvent("model.info", { provider, tier: candidateTiers?.[modelIdx] || tier, model,
          fallback: budgetFallback || modelIdx > 0 });
      }

      const { assistantContent, calls } = await readModelStream(upstream.body, (delta) => {
        produced = true;
        sendText(delta);
      });
      if (importMode && round === 0 && !calls.some(call => call.name === 'update_targeting')) {
        failed = true;
        sendEvent('assistant.error', { code: 'targeting_update_missing' });
        break;
      }
      if (!calls.length) break; // the model produced its final answer
      produced = true;

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
        const createsList = CREATES_LIST.includes(c.name);
        let result;
        const permitted = !importMode ? !IMPORT_ONLY_TOOLS.has(c.name)
          : IMPORT_READ_TOOLS.has(c.name) || (approval && targetingReady && createsList && !launchAttempted &&
            (!approvedRunTool(approval) || c.name === approvedRunTool(approval)));
        if (!permitted) {
          result = JSON.stringify({ error: createsList
            ? !approval ? 'validation_explicitement_requise' : !targetingReady ? 'cible_incomplete' : 'lancement_deja_effectue'
            : 'outil_indisponible_pour_ce_mode' });
        } else {
          if (createsList) launchAttempted = true;
          const args = importMode && (createsList || c.name === 'update_targeting' || c.name === 'count_database_targeting')
            ? approvedToolArgs(c.name, c.args, approval) : c.args;
          if (args == null) {
            result = JSON.stringify({ error: 'arguments_de_lancement_invalides' });
          } else {
            if (c.name !== 'update_targeting') sendEvent('tool.progress', {
              tool: c.name, label: TOOL_LABELS[c.name] || c.name.replace(/_/g, ' '),
              status: 'running', creates_list: createsList,
            });
            result = await executeTool(c.name, args, auth, { profile });
            let launched = false;
            try { launched = Boolean(JSON.parse(result).list_id); } catch { /* tool returned an error */ }
            if (c.name !== 'update_targeting') sendEvent('tool.progress', {
              tool: c.name, label: TOOL_LABELS[c.name] || c.name.replace(/_/g, ' '),
              status: 'completed', creates_list: createsList && launched,
            });
          }
        }

        if (importMode && c.name === 'update_targeting') {
          try {
            const criteria = JSON.parse(result);
            if (!criteria.error) {
              targetingReady = criteria.ready_to_launch === true;
              sendEvent('targeting.criteria', criteria);
            }
          } catch { /* invalid tool output is never sent as criteria */ }
        }
        if (importMode && c.name === 'count_database_targeting') {
          try {
            const preview = JSON.parse(result);
            if (Number.isSafeInteger(preview.count) && preview.count >= 0) {
              sendEvent('targeting.count', { count: preview.count, filters: preview.criteria_applied?.filters ?? [] });
            }
          } catch { /* failed previews cannot unlock validation */ }
        }

        // The clickable LinkedIn account card is built from the REAL tool result
        // here (server-side) — never from the model's text, so it cannot invent
        // accounts.
        if (c.name === "ask_linkedin_account") {
          try {
            const parsed = JSON.parse(result);
            if (Array.isArray(parsed.accounts) && parsed.accounts.length) {
              let salesNavigatorOnly = false;
              try { salesNavigatorOnly = JSON.parse(c.args || '{}').sales_navigator_only === true; } catch { /* invalid args */ }
              sendEvent("linkedin.accounts", { accounts: parsed.accounts, sales_navigator_only: salesNavigatorOnly });
            }
          } catch {
            /* ignore */
          }
        }
        if (changesData(c.name, result, c.args)) sendEvent("assistant.changed", {});
        for (const card of cardsForTool(c.name, result, c.args)) sendEvent("assistant.card", card);
        convo.push({ role: "tool", tool_call_id: c.id, content: result });
      }
    }
    // Certains modèles (préversions "stealth"…) répondent 200 sans rien émettre :
    // on le dit au lieu de fermer un flux vide.
    if (!closed && !produced && !failed) {
      sendText(
        "_(Ce modèle n'a renvoyé aucune réponse. Essaie un autre modèle — certains modèles en préversion ne répondent pas.)_",
      );
    }
    if (!closed) res.write("data: [DONE]\n\n");
  } catch (err) {
    if (!closed) sendEvent("assistant.error", { code: "stream_failed" });
    console.error("[ai] stream error:", err?.name || "Error");
  } finally {
    if (!closed) res.end();
  }
}

/* --------------------------------- routing -------------------------------- */

async function handleProviders(req, res, cors) {
  const caller = await authenticate(req, res, cors);
  if (!caller) return;
  const integrations = await listOpenAiIntegrations(caller.auth);
  if (!integrations.ok) return json(res, 502, { ok: false, errorKey: 'integration_unavailable' }, cors);
  return json(res, 200, {
    ok: true,
    openrouter_available: Boolean(AI_API_KEY),
    configured: { openai: integrations.integrations.length > 0, anthropic: false },
    openai_keys: integrations.integrations.map(({ id, name }) => ({ id, name })),
  }, cors);
}

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
    return json(res, 200, { ok: true, openrouter_available: Boolean(AI_API_KEY) }, cors);
  }

  if (req.method === "GET" && url.pathname === "/ai/meta") {
    return json(
      res,
      200,
      {
        ok: true,
        toolLabels: TOOL_LABELS,
        createsList: CREATES_LIST,
        // Paliers réellement disponibles (l'UI peut s'y adapter).
        tiers: {
          free: resolveModels('openrouter', "free").length > 0,
          simple: resolveModels('openrouter', "simple").length > 0,
          complex: resolveModels('openrouter', "complex").length > 0,
          custom: ALLOW_CUSTOM_MODEL,
        },
        freeCandidates: resolveModels('openrouter', "free").length,
        providers: MODEL_PROVIDERS,
      },
      cors,
    );
  }

  if (url.pathname === '/ai/providers' && req.method === 'GET') {
    return handleProviders(req, res, cors);
  }

  if (req.method === "POST" && url.pathname === "/ai/chat") {
    return handleChat(req, res, cors);
  }

  return json(res, 404, { ok: false, errorKey: "not_found" }, cors);
});

server.listen(PORT, () => {
  console.log(`[ai-server] listening on http://localhost:${PORT}`);
  console.log(`[ai-server] tiers -> free=${resolveModels('openrouter', "free").length} candidat(s) | simple=${AI_MODEL || "(unset)"} | complex=${AI_MODEL_COMPLEX || "(= simple)"} | custom=${ALLOW_CUSTOM_MODEL ? "autorise" : "desactive"}`);
  if (!AI_API_KEY) console.warn("[ai-server] NOTE: OpenRouter unavailable (AI_API_KEY not set)");
  if (!AI_MODEL) console.warn("[ai-server] NOTE: AI_MODEL non defini -> les paliers simple/complex sont indisponibles");
});
