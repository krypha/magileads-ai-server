/**
 * AiAssistant — composant React de test pour le serveur IA Groleads.
 *
 * Zéro dépendance (JSX + styles inline) → se colle dans n'importe quel front.
 *
 *   import AiAssistant from "./AiAssistant";
 *   <AiAssistant serverUrl="http://localhost:8787" />
 *
 * AUTH : le composant envoie le token Magileads de l'utilisateur connecté dans
 * l'en-tête Authorization. Par défaut il le lit dans le localStorage ("session",
 * le store zustand persisté). Dans ton app, passe plutôt :
 *
 *   getAccessToken={() => useSessionStore.getState().session?.access_token}
 *
 * Sur 401, on appelle onAuthError() (branche-y ton refresh axios) puis on retente
 * une fois — le serveur ne rafraîchit PAS les tokens, c'est le front qui gère.
 */

import { useCallback, useEffect, useRef, useState } from "react";

/* ------------------------------ petits utils ------------------------------ */

const uid = () => Math.random().toString(36).slice(2);

/** Lecture par défaut du token (store zustand persisté sous "session"). */
function defaultGetAccessToken() {
  try {
    return JSON.parse(localStorage.getItem("session"))?.state?.session?.access_token || null;
  } catch {
    return null;
  }
}

/** Parseur SSE incrémental : rend [{event, data}] au fil de l'eau. */
function createSseParser() {
  let buffer = "";
  return function push(chunk) {
    buffer += chunk;
    const out = [];
    const blocks = buffer.split("\n\n");
    buffer = blocks.pop() ?? "";
    for (const block of blocks) {
      let event = null;
      let data = "";
      for (const line of block.split("\n")) {
        const l = line.replace(/\r$/, "");
        if (l.startsWith("event:")) event = l.slice(6).trim();
        else if (l.startsWith("data:")) data += l.slice(5).trim();
      }
      if (data || event) out.push({ event, data });
    }
    return out;
  };
}

// Marqueur de garde-fou suppression émis par l'assistant.
const CONFIRM_RE = /\[\[CONFIRM_DELETE\]\]\s*(\{[\s\S]*?\})\s*\[\[\/CONFIRM_DELETE\]\]/;
// Marqueur de choix de compte : on ne l'AFFICHE jamais (la carte vient du serveur).
const PICK_RE = /\[\[PICK_ACCOUNT\]\]\s*(\{[\s\S]*?\})\s*\[\[\/PICK_ACCOUNT\]\]/;

const EXAMPLES = [
  "Combien de campagnes ai-je ?",
  "Montre-moi mes 3 plus grandes listes de contacts",
  "Je veux cibler des CEO à Londres sur LinkedIn",
  "Audite ma campagne la plus récente",
];

/* -------------------------------- composant ------------------------------- */

export default function AiAssistant({
  serverUrl = "http://localhost:8787",
  getAccessToken = defaultGetAccessToken,
  onAuthError, // optionnel : déclenche ton refresh de token, puis on retente
}) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [tool, setTool] = useState(null);
  const [tier, setTier] = useState("complex"); // "simple" | "complex"
  const [error, setError] = useState(null);
  const [picked, setPicked] = useState({}); // msgId -> nom du compte choisi
  const [resolved, setResolved] = useState({}); // msgId -> "confirmed" | "cancelled"

  const abortRef = useRef(null);
  const scrollRef = useRef(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, streaming, tool]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const patch = useCallback((id, fields) => {
    setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, ...fields } : m)));
  }, []);

  const send = useCallback(
    async (override) => {
      const text = (override ?? input).trim();
      if (!text || streaming) return;
      if (!override) setInput("");
      setError(null);

      const userMsg = { id: uid(), role: "user", content: text };
      const aId = uid();
      // Historique renvoyé au serveur (le modèle est sans mémoire).
      const history = [...messages, userMsg]
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map((m) => ({ role: m.role, content: m.content }));

      setMessages((prev) => [...prev, userMsg, { id: aId, role: "assistant", content: "" }]);
      setStreaming(true);
      setTool(null);

      try {
        // 2 tentatives max : la 1re peut échouer en 401 si l'access_token a expiré
        // (durée de vie ~30 min). On laisse le front le rafraîchir, puis on retente.
        for (let attempt = 0; attempt < 2; attempt++) {
          // Le token est relu À CHAQUE tentative → jamais un token périmé en cache.
          const token = getAccessToken?.();
          const ctrl = new AbortController();
          abortRef.current = ctrl;

          let res;
          try {
            res = await fetch(`${serverUrl}/ai/chat`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
              },
              body: JSON.stringify({ messages: history, tier }),
              signal: ctrl.signal,
            });
          } catch (e) {
            if (e?.name !== "AbortError") {
              setError(String(e?.message || e));
              patch(aId, { content: "_Impossible de joindre le serveur IA._" });
            }
            break;
          }

          if (res.status === 401) {
            // Le serveur ne rafraîchit pas les tokens : c'est le front qui gère.
            if (attempt === 0 && onAuthError) {
              await onAuthError();
              continue; // on retente avec le token fraîchement rafraîchi
            }
            patch(aId, { content: "_Session expirée — reconnecte-toi._" });
            break;
          }
          if (res.status === 429) {
            patch(aId, { content: "_Trop de requêtes, réessaie dans une minute._" });
            break;
          }
          if (res.status === 503) {
            patch(aId, { content: "_L'assistant n'est pas configuré côté serveur._" });
            break;
          }
          if (!res.ok || !res.body) {
            patch(aId, { content: "_Une erreur est survenue._" });
            break;
          }

          const reader = res.body.getReader();
          const dec = new TextDecoder();
          const parse = createSseParser();
          let acc = "";

          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            for (const ev of parse(dec.decode(value, { stream: true }))) {
              if (ev.event === "tool.progress") {
                try {
                  const j = JSON.parse(ev.data);
                  setTool(j.status === "completed" ? null : j.label || j.tool);
                } catch {
                  /* ignore */
                }
                continue;
              }
              if (ev.event === "linkedin.accounts") {
                // Carte cliquable alimentée par le SERVEUR (données réelles).
                try {
                  const j = JSON.parse(ev.data);
                  if (Array.isArray(j.accounts) && j.accounts.length) {
                    patch(aId, { pick: { accounts: j.accounts } });
                  }
                } catch {
                  /* ignore */
                }
                continue;
              }
              if (!ev.data || ev.data === "[DONE]") continue;
              try {
                const j = JSON.parse(ev.data);
                const delta = j.choices?.[0]?.delta?.content;
                if (delta) {
                  acc += delta;
                  patch(aId, { content: acc });
                }
              } catch {
                /* keep-alive */
              }
            }
          }
          if (!acc) patch(aId, { content: "_(réponse vide)_" });
          break; // terminé
        }
      } finally {
        setStreaming(false);
        setTool(null);
        abortRef.current = null;
      }
    },
    [input, messages, streaming, tier, serverUrl, getAccessToken, onAuthError, patch],
  );

  function onPickAccount(msgId, acc) {
    if (picked[msgId]) return;
    setPicked((p) => ({ ...p, [msgId]: acc.name }));
    send(`Utilise le compte LinkedIn « ${acc.name} » (id ${acc.id}).`);
  }

  function onConfirmDelete(msgId, ok) {
    if (resolved[msgId]) return;
    setResolved((r) => ({ ...r, [msgId]: ok ? "confirmed" : "cancelled" }));
    send(ok ? "Oui, confirme la suppression." : "Non, annule la suppression.");
  }

  return (
    <div style={S.wrap}>
      <header style={S.header}>
        <div>
          <div style={{ fontWeight: 600 }}>Assistant IA</div>
          <div style={S.sub}>Groleads</div>
        </div>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
          <div style={S.tierGroup}>
            {["simple", "complex"].map((tv) => (
              <button
                key={tv}
                onClick={() => setTier(tv)}
                style={{ ...S.tierBtn, ...(tier === tv ? S.tierBtnOn : null) }}
              >
                {tv === "simple" ? "Simple" : "Complexe"}
              </button>
            ))}
          </div>
          <button style={S.ghostBtn} onClick={() => setMessages([])} disabled={streaming}>
            Nouvelle conversation
          </button>
        </div>
      </header>

      <div ref={scrollRef} style={S.scroll}>
        {messages.length === 0 ? (
          <div style={{ textAlign: "center", color: "#64748b", paddingTop: 24 }}>
            <p style={{ fontWeight: 600, color: "#0f172a" }}>Pose-moi une question sur ton compte</p>
            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 16 }}>
              {EXAMPLES.map((ex) => (
                <button key={ex} style={S.example} onClick={() => setInput(ex)}>
                  {ex}
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((m) => (
            <Bubble
              key={m.id}
              msg={m}
              picked={picked[m.id]}
              resolved={resolved[m.id]}
              onPickAccount={onPickAccount}
              onConfirmDelete={onConfirmDelete}
            />
          ))
        )}

        {streaming && (
          <div style={{ color: "#64748b", fontSize: 13, padding: "8px 0" }}>
            {tool ? `⚙️ ${tool}…` : "…réflexion"}
          </div>
        )}
        {error && <div style={S.error}>{error}</div>}
      </div>

      <div style={S.composer}>
        <textarea
          rows={1}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          placeholder="Écris ton message… (ex. « Combien de campagnes ai-je ? »)"
          style={S.textarea}
        />
        {streaming ? (
          <button style={S.sendBtn} onClick={() => abortRef.current?.abort()}>
            Stop
          </button>
        ) : (
          <button style={S.sendBtn} onClick={() => send()} disabled={!input.trim()}>
            Envoyer
          </button>
        )}
      </div>
    </div>
  );
}

/* --------------------------------- bulle ---------------------------------- */

function Bubble({ msg, picked, resolved, onPickAccount, onConfirmDelete }) {
  const isUser = msg.role === "user";
  let text = msg.content || "";
  let confirm = null;

  if (!isUser) {
    const m = text.match(CONFIRM_RE);
    if (m) {
      try {
        confirm = JSON.parse(m[1]);
      } catch {
        confirm = null;
      }
      text = text.replace(CONFIRM_RE, "").trim();
    }
    // On retire un éventuel marqueur tapé par le modèle : la carte vient du serveur.
    text = text.replace(PICK_RE, "").trim();
  }

  const copy = () => navigator.clipboard?.writeText(text).catch(() => {});

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, margin: "10px 0" }}>
      {(text || (!confirm && !msg.pick)) && (
        <div style={isUser ? S.userRow : undefined}>
          <div style={isUser ? S.userBubble : S.assistantText}>{text || "…"}</div>
        </div>
      )}

      {text && (
        <button onClick={copy} style={{ ...S.copyBtn, alignSelf: isUser ? "flex-end" : "flex-start" }}>
          Copier
        </button>
      )}

      {/* Carte cliquable des comptes LinkedIn — données RÉELLES envoyées par le serveur */}
      {msg.pick?.accounts?.length > 0 && (
        <div style={S.pickCard}>
          <div style={{ fontWeight: 600, fontSize: 14 }}>Choisis un compte LinkedIn</div>
          {picked ? (
            <div style={{ fontSize: 13, color: "#64748b", marginTop: 8 }}>Compte choisi : {picked}</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 10 }}>
              {msg.pick.accounts.map((a) => (
                <button key={a.id} style={S.pickBtn} onClick={() => onPickAccount(msg.id, a)}>
                  {a.name} <span style={{ color: "#94a3b8" }}>→</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Garde-fou suppression */}
      {confirm && (
        <div style={S.dangerCard}>
          <div style={{ fontWeight: 600, color: "#b91c1c" }}>
            ⚠️ Supprimer {confirm.count} contact(s) de « {confirm.list} » ?
          </div>
          <div style={{ fontSize: 12, color: "#b91c1c", opacity: 0.85, marginTop: 4 }}>
            Cette action est définitive.
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            {resolved ? (
              <span style={{ fontSize: 13, color: "#64748b" }}>
                {resolved === "confirmed" ? "Suppression confirmée" : "Annulé"}
              </span>
            ) : (
              <>
                <button style={S.dangerBtn} onClick={() => onConfirmDelete(msg.id, true)}>
                  Supprimer
                </button>
                <button style={S.ghostBtn} onClick={() => onConfirmDelete(msg.id, false)}>
                  Annuler
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/* --------------------------------- styles --------------------------------- */

const S = {
  wrap: {
    display: "flex",
    flexDirection: "column",
    height: "80vh",
    maxWidth: 820,
    margin: "0 auto",
    border: "1px solid #e2e8f0",
    borderRadius: 12,
    overflow: "hidden",
    background: "#fff",
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
    color: "#0f172a",
  },
  header: { display: "flex", alignItems: "center", gap: 12, padding: "10px 16px", borderBottom: "1px solid #e2e8f0" },
  sub: { fontSize: 12, color: "#64748b" },
  tierGroup: { display: "inline-flex", border: "1px solid #e2e8f0", borderRadius: 8, padding: 2 },
  tierBtn: { border: 0, background: "transparent", padding: "4px 10px", fontSize: 12, borderRadius: 6, cursor: "pointer", color: "#64748b" },
  tierBtnOn: { background: "#0f766e", color: "#fff" },
  ghostBtn: { border: "1px solid #e2e8f0", background: "#fff", padding: "6px 10px", fontSize: 12, borderRadius: 8, cursor: "pointer" },
  scroll: { flex: 1, overflowY: "auto", padding: "12px 16px" },
  userRow: { display: "flex", justifyContent: "flex-end" },
  userBubble: { background: "#0f766e", color: "#fff", padding: "8px 12px", borderRadius: 14, maxWidth: "85%", whiteSpace: "pre-wrap" },
  assistantText: { whiteSpace: "pre-wrap", lineHeight: 1.6, fontSize: 14 },
  copyBtn: { border: 0, background: "transparent", color: "#94a3b8", fontSize: 11, cursor: "pointer", padding: 0 },
  example: { border: "1px solid #e2e8f0", background: "#fff", borderRadius: 8, padding: "8px 12px", textAlign: "left", cursor: "pointer", fontSize: 13 },
  pickCard: { border: "1px solid #99f6e4", background: "#f0fdfa", borderRadius: 12, padding: 14 },
  pickBtn: { display: "flex", justifyContent: "space-between", alignItems: "center", border: "1px solid #e2e8f0", background: "#fff", borderRadius: 8, padding: "8px 12px", cursor: "pointer", fontSize: 14, fontWeight: 500 },
  dangerCard: { border: "1px solid #fecaca", background: "#fef2f2", borderRadius: 12, padding: 14 },
  dangerBtn: { border: 0, background: "#dc2626", color: "#fff", borderRadius: 8, padding: "6px 12px", fontSize: 12, fontWeight: 600, cursor: "pointer" },
  composer: { display: "flex", gap: 8, padding: 12, borderTop: "1px solid #e2e8f0" },
  textarea: { flex: 1, resize: "none", minHeight: 42, maxHeight: 160, padding: "10px 12px", borderRadius: 10, border: "1px solid #cbd5e1", fontSize: 14, fontFamily: "inherit" },
  sendBtn: { border: 0, background: "#0f766e", color: "#fff", borderRadius: 10, padding: "0 18px", fontWeight: 600, cursor: "pointer" },
  error: { color: "#b91c1c", fontSize: 12, marginTop: 8 },
};
