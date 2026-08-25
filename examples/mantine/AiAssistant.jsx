/**
 * AiAssistant (Mantine) — reprise complète de l'assistant /ai de Magileads.
 *
 * Fonctionnalités (parité avec l'app Next) :
 *   • streaming du texte + indicateur d'outil en cours ("Lecture des campagnes…")
 *   • rendu Markdown riche (titres, TABLEAUX d'audit, listes, code, liens)
 *   • bouton Copier sur chaque message + Exporter (rapport HTML/PDF) sur les audits
 *   • sélecteur de modèle : Gratuit / Simple / Complexe / Personnalisé
 *   • respecte le COMPTE SWITCHÉ (user_switch) comme le reste de l'app
 *   • carte cliquable de choix du compte LinkedIn (données réelles du serveur)
 *   • garde-fou rouge avant toute suppression de contacts
 *   • notification quand un ciblage est terminé (+ lien vers la liste créée)
 *   • conversation persistée par utilisateur, bouton Stop, rejeu auto après 401
 *
 * Dépendances : @mantine/core (v7+), @mantine/notifications, @tabler/icons-react,
 *               react-markdown, remark-gfm
 *
 * Exemple d'intégration :
 *
 *   import AiAssistant from "./AiAssistant";
 *   import { mainAxios } from "../api/axios";
 *   import { useSessionStore, useProfileStore } from "../stores/UserStore";
 *
 *   const profile = useProfileStore((s) => s.profile);
 *   <AiAssistant
 *     serverUrl={window._env_.AI_SERVER_URL}
 *     // Compte principal + compte SWITCHÉ (comme l'interceptor axios) :
 *     getAuthHeaders={() => {
 *       const s = useSessionStore.getState();
 *       return {
 *         ...(s.session?.access_token ? { Authorization: `Bearer ${s.session.access_token}` } : {}),
 *         ...(s.user_switch?.token ? { "X-API-Key": s.user_switch.token } : {}),
 *       };
 *     }}
 *     onAuthError={async () => { try { await mainAxios.get("/users/me"); } catch {} }}
 *     apiClient={mainAxios}                        // active le suivi de fin de ciblage
 *     userKey={profile?.email}                     // persistance par utilisateur
 *     onOpenList={(id) => navigate(`/contact-lists/${id}`)}
 *   />
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActionIcon,
  Alert,
  Badge,
  Box,
  Button,
  Card,
  CopyButton,
  Group,
  Loader,
  Paper,
  ScrollArea,
  SegmentedControl,
  Stack,
  Text,
  Textarea,
  TextInput,
  ThemeIcon,
  Tooltip,
  UnstyledButton,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import {
  IconAlertTriangle,
  IconArrowRight,
  IconBrandLinkedin,
  IconCheck,
  IconCopy,
  IconDownload,
  IconPencilPlus,
  IconPlayerStopFilled,
  IconRobot,
  IconSend,
  IconSparkles,
  IconTool,
} from "@tabler/icons-react";

import MarkdownMessage from "./MarkdownMessage";
import { exportReport, reportTitleFrom } from "./exportReport";

/* ------------------------------- constantes ------------------------------- */

const uid = () => `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

// Marqueur de garde-fou suppression émis par l'assistant.
const CONFIRM_RE = /\[\[CONFIRM_DELETE\]\]\s*(\{[\s\S]*?\})\s*\[\[\/CONFIRM_DELETE\]\]/;
// Si le modèle tape ce marqueur, on le SUPPRIME : la carte de comptes vient du serveur.
const PICK_RE = /\[\[PICK_ACCOUNT\]\]\s*(\{[\s\S]*?\})\s*\[\[\/PICK_ACCOUNT\]\]/;
// Une réponse "type rapport" (titre ou tableau) -> on propose l'export.
const REPORT_RE = /(^|\n)#{1,3}\s+\S|(^|\n)\s*\|.*\|/;

const EXAMPLES = [
  "Combien de campagnes ai-je ?",
  "Quelles sont mes 3 plus grandes listes de contacts ?",
  "Je veux cibler des DAF à Paris sur LinkedIn",
  "Audite ma campagne la plus récente : scénario, stats vs benchmarks et plan d'action.",
];

/** Formatage des nombres à la française (1 240). */
const nf = new Intl.NumberFormat("fr-FR");

/** Un job d'extraction est-il encore en cours ? (les états sont capitalisés côté API) */
const TERMINAL = ["completed", "finished", "done", "error", "failed", "cancelled", "canceled"];
const isActiveJob = (j) => !TERMINAL.includes(String(j?.state ?? "").toLowerCase());

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

/**
 * En-têtes d'authentification, alignés sur l'interceptor axios de l'app :
 *   Authorization: Bearer <token du compte principal>
 *   X-API-Key:     <token du compte SWITCHÉ>   (quand un switch est actif)
 * On envoie les deux : Magileads applique sa précédence, donc l'assistant agit
 * sur le MÊME compte que le reste de l'application.
 *
 * En production, préfère passer la prop `getAuthHeaders` qui lit le store en direct :
 *   getAuthHeaders={() => {
 *     const s = useSessionStore.getState();
 *     return {
 *       ...(s.session?.access_token ? { Authorization: `Bearer ${s.session.access_token}` } : {}),
 *       ...(s.user_switch?.token ? { "X-API-Key": s.user_switch.token } : {}),
 *     };
 *   }}
 */
function defaultGetAuthHeaders() {
  try {
    const st = JSON.parse(localStorage.getItem("session"))?.state ?? {};
    const h = {};
    if (st.session?.access_token) h.Authorization = `Bearer ${st.session.access_token}`;
    if (st.user_switch?.token) h["X-API-Key"] = st.user_switch.token;
    return h;
  } catch {
    return {};
  }
}

/**
 * Lit une clé de persistance, en MIGRANT au passage depuis l'ancien préfixe
 * `groleads:ai:*` (renommage Magileads). Sans ça, les utilisateurs déjà en place
 * perdraient leur conversation et leur choix de palier au premier chargement.
 * La migration est ponctuelle : l'ancienne clé est recopiée puis supprimée.
 */
function readStored(key) {
  try {
    const current = localStorage.getItem(key);
    if (current !== null) return current;
    const legacyKey = key.replace(/^magileads:/, "groleads:");
    const legacy = localStorage.getItem(legacyKey);
    if (legacy !== null) {
      localStorage.setItem(key, legacy);
      localStorage.removeItem(legacyKey);
      return legacy;
    }
  } catch {
    /* quota / indisponible */
  }
  return null;
}

/** Paliers proposés. Le nom réel du modèle reste côté serveur (sauf "custom"). */
const TIERS = [
  { label: "Gratuit", value: "free" },
  { label: "Simple", value: "simple" },
  { label: "Complexe", value: "complex" },
  { label: "Perso.", value: "custom" },
];

/* -------------------------------- composant ------------------------------- */

export default function AiAssistant({
  serverUrl = "https://magileads-ai-server.krypha.com",
  /** Retourne les en-têtes d'auth (compte principal + compte switché). */
  getAuthHeaders = defaultGetAuthHeaders,
  /** Compat : si fourni, on construit l'en-tête Bearer à partir de ce token. */
  getAccessToken,
  onAuthError,
  apiClient, // optionnel (ex. mainAxios) : active le suivi de fin de ciblage
  userKey, // optionnel : clé de persistance (email/id de l'utilisateur)
  onOpenList, // optionnel : (listId) => navigate(...)
  height = "calc(100vh - 140px)",
}) {
  const storeKey = userKey ? `magileads:ai:${userKey}` : null;

  const [messages, setMessages] = useState(() => {
    if (typeof window === "undefined" || !userKey) return [];
    try {
      const raw = readStored(`magileads:ai:${userKey}`);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  });
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [tool, setTool] = useState(null);
  // Gardé pour rester compatible SSR (Next.js) : pas d'accès localStorage au 1er rendu serveur.
  const [tier, setTier] = useState(() => {
    if (typeof window === "undefined") return "complex";
    return readStored("magileads:ai:tier") || "complex";
  });
  // Palier "Perso." : l'id du modèle est saisi par l'utilisateur (ex. stealth/ox-alpha).
  const [customModel, setCustomModel] = useState(() => {
    if (typeof window === "undefined") return "";
    return readStored("magileads:ai:customModel") || "";
  });
  // Modèle réellement utilisé, annoncé par le serveur (affiché pour free/custom).
  const [modelInfo, setModelInfo] = useState(null);
  const [error, setError] = useState(null);
  const [picked, setPicked] = useState({}); // msgId -> nom du compte choisi
  const [resolved, setResolved] = useState({}); // msgId -> "confirmed" | "cancelled"

  const abortRef = useRef(null);
  const viewportRef = useRef(null);
  const cancelledRef = useRef(false);
  const watchGenRef = useRef(0);

  // Remise à zéro au (re)montage : sinon le nettoyage d'un démontage précédent
  // (StrictMode en dev) laisserait le watcher désactivé pour toujours.
  useEffect(() => {
    cancelledRef.current = false;
    return () => {
      cancelledRef.current = true;
      abortRef.current?.abort();
    };
  }, []);

  // Persistance (on évite d'écrire à chaque token pendant le streaming).
  useEffect(() => {
    if (!storeKey || streaming) return;
    try {
      localStorage.setItem(storeKey, JSON.stringify(messages.slice(-80)));
    } catch {
      /* quota */
    }
  }, [messages, storeKey, streaming]);

  useEffect(() => {
    try {
      localStorage.setItem("magileads:ai:tier", tier);
      localStorage.setItem("magileads:ai:customModel", customModel);
    } catch {
      /* ignore */
    }
  }, [tier, customModel]);

  // Auto-scroll en bas.
  useEffect(() => {
    viewportRef.current?.scrollTo({ top: viewportRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, streaming, tool]);

  const patch = useCallback((id, fields) => {
    setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, ...fields } : m)));
  }, []);

  /* ------------------- suivi de fin de ciblage (optionnel) ------------------ */

  const fetchLists = useCallback(async () => {
    if (!apiClient) return [];
    try {
      const options = JSON.stringify({
        per_page: 25,
        sort: { field_name: "id", sort_direction: "desc" },
      });
      const { data } = await apiClient.get("/contact-lists-paginated/page/1", {
        params: { options },
      });
      return (data?.results ?? []).map((l) => ({
        id: l.id,
        name: l.name,
        contacts: l.number_of_contacts ?? 0,
        jobs: l.state_details ?? [],
      }));
    } catch {
      return [];
    }
  }, [apiClient]);

  const activeIds = (rows) =>
    new Set(rows.filter((r) => (r.jobs ?? []).some(isActiveJob)).map((r) => r.id));

  /** Sonde les listes jusqu'à ce que le ciblage lancé pendant ce tour soit fini. */
  const runWatcher = useCallback(
    async (baselineP) => {
      if (!apiClient) return;
      const myGen = ++watchGenRef.current;
      const baseline = await baselineP;
      const watched = new Map();
      let ticks = 0;

      const loop = async () => {
        if (cancelledRef.current || watchGenRef.current !== myGen) return;
        const rows = await fetchLists();
        const active = activeIds(rows);
        for (const r of rows) if (active.has(r.id) && !baseline.has(r.id)) watched.set(r.id, r.name);
        for (const [id, name] of Array.from(watched)) {
          if (!active.has(id)) {
            watched.delete(id);
            const row = rows.find((r) => r.id === id);
            const contacts = row?.contacts ?? 0;
            setMessages((prev) => [
              ...prev,
              {
                id: uid(),
                role: "notice",
                content: `Ciblage terminé : « ${name} » (${nf.format(contacts)} contacts)`,
                list: { id, name, contacts },
              },
            ]);
            notifications.show({
              title: "Ciblage terminé",
              message: `« ${name} » — ${nf.format(contacts)} contacts`,
              color: "teal",
            });
          }
        }
        ticks += 1;
        if (watched.size === 0 && ticks >= 4) return; // rien de neuf après ~1 min
        if (ticks >= 40) return; // plafond ~10 min
        setTimeout(loop, 15000);
      };
      setTimeout(loop, 4000);
    },
    [apiClient, fetchLists],
  );

  /* ----------------------------- envoi / stream ---------------------------- */

  const send = useCallback(
    async (override) => {
      const text = (override ?? input).trim();
      if (!text || streaming) return;
      if (tier === "custom" && !customModel.trim()) {
        setError("Renseigne l'identifiant du modèle (ex. stealth/ox-alpha).");
        return;
      }
      if (!override) setInput("");
      setError(null);
      setModelInfo(null);

      const userMsg = { id: uid(), role: "user", content: text };
      const aId = uid();
      // Le modèle est sans mémoire : on renvoie tout l'historique utile.
      const history = [...messages, userMsg]
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map((m) => ({ role: m.role, content: m.content }));

      setMessages((prev) => [...prev, userMsg, { id: aId, role: "assistant", content: "" }]);
      setStreaming(true);
      setTool(null);

      const baselineP = apiClient ? fetchLists().then(activeIds) : null;
      let launchedTargeting = false;

      try {
        // 2 tentatives : la 1re peut échouer en 401 si l'access_token a expiré
        // (durée de vie ~30 min) -> le front rafraîchit, puis on rejoue.
        for (let attempt = 0; attempt < 2; attempt++) {
          // Relu à CHAQUE tentative : token frais + compte switché à jour.
          const authHeaders = getAccessToken
            ? (() => {
                const t = getAccessToken();
                return t ? { Authorization: `Bearer ${t}` } : {};
              })()
            : getAuthHeaders?.() ?? {};
          const ctrl = new AbortController();
          abortRef.current = ctrl;

          let res;
          try {
            res = await fetch(`${serverUrl}/ai/chat`, {
              method: "POST",
              headers: { "Content-Type": "application/json", ...authHeaders },
              body: JSON.stringify({
                messages: history,
                tier,
                // Seul le palier "Perso." pilote le modèle depuis le client.
                ...(tier === "custom" ? { model: customModel.trim() } : {}),
              }),
              signal: ctrl.signal,
            });
          } catch (e) {
            if (e?.name !== "AbortError") {
              setError("Impossible de joindre le serveur IA.");
              patch(aId, { content: "_Impossible de joindre le serveur IA._" });
            }
            break;
          }

          if (res.status === 401) {
            if (attempt === 0 && onAuthError) {
              await onAuthError();
              continue; // on rejoue avec le token rafraîchi
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
                  if (j.creates_list) launchedTargeting = true;
                } catch {
                  /* ignore */
                }
                continue;
              }
              if (ev.event === "model.info") {
                try {
                  setModelInfo(JSON.parse(ev.data));
                } catch {
                  /* ignore */
                }
                continue;
              }
              if (ev.event === "linkedin.accounts") {
                // Carte alimentée par le SERVEUR (comptes réels) -> pas d'hallucination.
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
          break;
        }
      } finally {
        setStreaming(false);
        setTool(null);
        abortRef.current = null;
        if (launchedTargeting && baselineP) void runWatcher(baselineP);
      }
    },
    [
      input,
      messages,
      streaming,
      tier,
      customModel,
      serverUrl,
      getAuthHeaders,
      getAccessToken,
      onAuthError,
      patch,
      apiClient,
      fetchLists,
      runWatcher,
    ],
  );

  const newChat = () => {
    if (streaming) return;
    setMessages([]);
    setInput("");
    setPicked({});
    setResolved({});
    setError(null);
  };

  const onPickAccount = (msgId, acc) => {
    if (picked[msgId]) return;
    setPicked((p) => ({ ...p, [msgId]: acc.name }));
    send(`Utilise le compte LinkedIn « ${acc.name} » (id ${acc.id}).`);
  };

  const onConfirmDelete = (msgId, ok) => {
    if (resolved[msgId]) return;
    setResolved((r) => ({ ...r, [msgId]: ok ? "confirmed" : "cancelled" }));
    send(ok ? "Oui, je confirme la suppression." : "Non, annule la suppression.");
  };

  const empty = messages.length === 0;

  return (
    <Paper withBorder radius="md" style={{ display: "flex", flexDirection: "column", height }}>
      {/* ------------------------------- en-tête ------------------------------ */}
      <Group
        justify="space-between"
        px="md"
        py="xs"
        wrap="nowrap"
        style={{ borderBottom: "1px solid var(--mantine-color-default-border)" }}
      >
        <Group gap="sm" wrap="nowrap">
          <ThemeIcon variant="light" radius="md" size="lg">
            <IconRobot size={18} />
          </ThemeIcon>
          <div>
            <Text fw={600} size="sm" lh={1.2}>
              Assistant IA
            </Text>
            <Text size="xs" c="dimmed">
              Prospection assistée
            </Text>
          </div>
        </Group>

        <Group gap="xs" wrap="nowrap">
          {/* Le nom réel du modèle reste côté serveur pour Gratuit/Simple/Complexe. */}
          <SegmentedControl size="xs" value={tier} onChange={setTier} data={TIERS} />

          {tier === "custom" && (
            <TextInput
              size="xs"
              w={200}
              placeholder="editeur/modele"
              value={customModel}
              onChange={(e) => setCustomModel(e.currentTarget.value)}
              error={Boolean(customModel) && !/^[a-z0-9][\w.-]*\/[\w.:-]+$/i.test(customModel.trim())}
              aria-label="Identifiant du modèle"
            />
          )}

          {/* Modèle réellement utilisé : utile quand le palier Gratuit a basculé. */}
          {modelInfo && (tier === "free" || tier === "custom") && (
            <Tooltip
              label={
                modelInfo.fallback
                  ? "Modèle de repli (le précédent était saturé ou indisponible)"
                  : "Modèle utilisé"
              }
              withArrow
            >
              <Badge size="xs" variant="light" color={modelInfo.fallback ? "orange" : "gray"}>
                {modelInfo.model}
              </Badge>
            </Tooltip>
          )}

          <Button
            size="xs"
            variant="subtle"
            color="gray"
            leftSection={<IconPencilPlus size={16} />}
            onClick={newChat}
            disabled={streaming || empty}
          >
            Nouvelle conversation
          </Button>
        </Group>
      </Group>

      {/* ------------------------------ messages ------------------------------ */}
      <ScrollArea style={{ flex: 1 }} viewportRef={viewportRef} type="auto">
        <Box px="md" py="lg" mx="auto" style={{ maxWidth: 780 }}>
          {empty ? (
            <Stack align="center" gap="sm" mt="xl">
              <ThemeIcon variant="light" radius="lg" size={48}>
                <IconSparkles size={26} />
              </ThemeIcon>
              <Text fw={600}>Pose-moi une question sur ton compte</Text>
              <Text size="sm" c="dimmed" ta="center">
                Campagnes, listes, contacts, PRM, ciblage, audits…
              </Text>
              <Stack gap="xs" mt="md" w="100%">
                {EXAMPLES.map((ex) => (
                  <UnstyledButton
                    key={ex}
                    onClick={() => setInput(ex)}
                    style={{
                      border: "1px solid var(--mantine-color-default-border)",
                      borderRadius: "var(--mantine-radius-md)",
                      padding: "10px 14px",
                    }}
                  >
                    <Text size="sm">{ex}</Text>
                  </UnstyledButton>
                ))}
              </Stack>
            </Stack>
          ) : (
            <Stack gap="md">
              {messages.map((m) => (
                <MessageRow
                  key={m.id}
                  msg={m}
                  picked={picked[m.id]}
                  resolved={resolved[m.id]}
                  onPickAccount={onPickAccount}
                  onConfirmDelete={onConfirmDelete}
                  onOpenList={onOpenList}
                />
              ))}
            </Stack>
          )}

          {streaming && (
            <Group gap="xs" mt="md" c="dimmed">
              <Loader size="xs" />
              {tool ? (
                <Group gap={6}>
                  <IconTool size={14} />
                  <Text size="sm">{tool}…</Text>
                </Group>
              ) : (
                <Text size="sm">Réflexion…</Text>
              )}
            </Group>
          )}

          {error && (
            <Alert color="red" variant="light" mt="md" icon={<IconAlertTriangle size={16} />}>
              {error}
            </Alert>
          )}
        </Box>
      </ScrollArea>

      {/* ------------------------------ composer ----------------------------- */}
      <Group
        gap="xs"
        p="sm"
        align="flex-end"
        wrap="nowrap"
        style={{ borderTop: "1px solid var(--mantine-color-default-border)" }}
      >
        <Textarea
          style={{ flex: 1 }}
          autosize
          minRows={1}
          maxRows={6}
          value={input}
          onChange={(e) => setInput(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          placeholder="Écris ton message… (Entrée pour envoyer, Maj+Entrée pour un retour à la ligne)"
        />
        {streaming ? (
          <Tooltip label="Arrêter">
            <ActionIcon
              size="lg"
              variant="default"
              onClick={() => abortRef.current?.abort()}
              aria-label="Arrêter"
            >
              <IconPlayerStopFilled size={16} />
            </ActionIcon>
          </Tooltip>
        ) : (
          <Tooltip label="Envoyer">
            <ActionIcon
              size="lg"
              onClick={() => send()}
              disabled={!input.trim() || (tier === "custom" && !customModel.trim())}
              aria-label="Envoyer"
            >
              <IconSend size={16} />
            </ActionIcon>
          </Tooltip>
        )}
      </Group>
    </Paper>
  );
}

/* ------------------------------- une ligne -------------------------------- */

function MessageRow({ msg, picked, resolved, onPickAccount, onConfirmDelete, onOpenList }) {
  const contentRef = useRef(null);

  // Notification interne (ciblage terminé) -> carte centrée + lien vers la liste.
  if (msg.role === "notice") {
    return (
      <Group justify="center">
        <Card withBorder radius="md" padding="sm" bg="var(--mantine-color-teal-light)">
          <Group gap="xs">
            <IconSparkles size={16} />
            <Text size="sm" fw={500}>
              {msg.content}
            </Text>
            {msg.list && onOpenList && (
              <Button
                size="compact-xs"
                rightSection={<IconArrowRight size={14} />}
                onClick={() => onOpenList(msg.list.id)}
              >
                Voir la liste
              </Button>
            )}
          </Group>
        </Card>
      </Group>
    );
  }

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
    // On ne rend JAMAIS une carte depuis le texte du modèle (cf. msg.pick).
    text = text.replace(PICK_RE, "").trim();
  }

  const isReport = !isUser && REPORT_RE.test(text);

  return (
    <Stack gap={6}>
      {(text || (!confirm && !msg.pick)) &&
        (isUser ? (
          <Group justify="flex-end">
            <Paper
              radius="lg"
              px="md"
              py="xs"
              bg="var(--mantine-color-teal-filled)"
              c="white"
              style={{ maxWidth: "85%", whiteSpace: "pre-wrap", wordBreak: "break-word" }}
            >
              <Text size="sm" inherit>
                {text || "…"}
              </Text>
            </Paper>
          </Group>
        ) : (
          <div ref={contentRef}>
            {text ? <MarkdownMessage>{text}</MarkdownMessage> : <Text c="dimmed">…</Text>}
          </div>
        ))}

      {/* actions : copier (+ exporter sur les rapports) */}
      {text && (
        <Group gap={4} justify={isUser ? "flex-end" : "flex-start"}>
          <CopyButton value={text} timeout={1500}>
            {({ copied, copy }) => (
              <Tooltip label={copied ? "Copié" : "Copier"} withArrow>
                <ActionIcon size="sm" variant="subtle" color="gray" onClick={copy} aria-label="Copier">
                  {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
                </ActionIcon>
              </Tooltip>
            )}
          </CopyButton>

          {isReport && (
            <Button
              size="compact-xs"
              variant="default"
              leftSection={<IconDownload size={14} />}
              onClick={() => {
                const html = contentRef.current?.innerHTML;
                if (!html) return;
                const ok = exportReport(html, { title: reportTitleFrom(text) });
                if (!ok) {
                  notifications.show({
                    message: "Fenêtre bloquée : autorise les pop-ups pour exporter le rapport.",
                    color: "red",
                  });
                }
              }}
            >
              Exporter
            </Button>
          )}
        </Group>
      )}

      {/* carte cliquable des comptes LinkedIn (données SERVEUR) */}
      {msg.pick?.accounts?.length > 0 && (
        <Card withBorder radius="md" padding="md">
          <Group gap="xs" mb="xs">
            <IconBrandLinkedin size={18} color="var(--mantine-color-blue-6)" />
            <Text fw={600} size="sm">
              Choisis un compte LinkedIn
            </Text>
          </Group>
          {picked ? (
            <Group gap={6}>
              <IconCheck size={14} />
              <Text size="sm" c="dimmed">
                Compte choisi : {picked}
              </Text>
            </Group>
          ) : (
            <Stack gap="xs">
              {msg.pick.accounts.map((a) => (
                <Button
                  key={a.id}
                  variant="default"
                  justify="space-between"
                  rightSection={<IconArrowRight size={16} />}
                  leftSection={<IconBrandLinkedin size={16} />}
                  onClick={() => onPickAccount(msg.id, a)}
                  fullWidth
                >
                  <Text size="sm" fw={500} truncate>
                    {a.name}
                  </Text>
                </Button>
              ))}
            </Stack>
          )}
        </Card>
      )}

      {/* garde-fou : confirmation avant suppression */}
      {confirm && (
        <Alert
          color="red"
          variant="light"
          radius="md"
          icon={<IconAlertTriangle size={18} />}
          title={`Supprimer ${nf.format(confirm.count ?? 0)} contact(s) de « ${confirm.list ?? ""} » ?`}
        >
          <Text size="xs" c="red.8" mb="sm">
            Cette action est définitive et irréversible.
          </Text>
          {resolved ? (
            <Badge color={resolved === "confirmed" ? "red" : "gray"} variant="light">
              {resolved === "confirmed" ? "Suppression confirmée" : "Annulé"}
            </Badge>
          ) : (
            <Group gap="xs">
              <Button size="xs" color="red" onClick={() => onConfirmDelete(msg.id, true)}>
                Supprimer définitivement
              </Button>
              <Button size="xs" variant="default" onClick={() => onConfirmDelete(msg.id, false)}>
                Annuler
              </Button>
            </Group>
          )}
        </Alert>
      )}
    </Stack>
  );
}
