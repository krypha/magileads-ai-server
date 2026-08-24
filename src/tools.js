/**
 * AI tools (OpenAI-compatible function schemas) + their executor.
 *
 * Every tool runs SERVER-SIDE with the CALLER's own Magileads credentials, so the
 * model can only ever see that user's data — and the credential itself never
 * enters the model context (the model only receives tool *results*).
 */

import {
  getMe,
  listDataFields,
  listLinkedinAccounts,
  searchLinkedinLocations,
  generatePeoplesSearchUrl,
  linkedinExtract,
  generateGoogleMapsUrls,
  extractGoogleMaps,
  listContactListsPaginated,
  getContactListProfile,
  listContactListContacts,
  searchContactListContacts,
  deleteContactsSelection,
  listProgrammationsStats,
  getProgrammationStats,
  getWorkflow,
  listPrmStatuses,
  listPrmCustomStatuses,
  listPrmContacts,
  getPrmContact,
  listPrmNurturings,
} from "./magileads.js";

export const AI_TOOLS = [
  {
    type: "function",
    function: {
      name: "get_account_overview",
      description:
        "Profil du compte Groleads connecté (nom, email, abonnement). Pas de solde de crédits exposé par l'API.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "list_campaigns",
      description:
        "Liste les campagnes (programmations) du compte avec leurs statistiques (statut, contactés, taux d'ouverture/clic/réponse, date). Recherche libre optionnelle.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Filtre texte sur le nom (optionnel)." },
          page: { type: "number", description: "Page (défaut 1)." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_campaign_statistics",
      description: "Statistiques détaillées (par étape) d'une campagne, par son id.",
      parameters: {
        type: "object",
        properties: { id: { type: "number", description: "Id de la campagne (programmation)." } },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_campaign",
      description:
        "Détail du scénario d'une campagne (étapes, canaux email/LinkedIn, délais) par son workflow_id (fourni par list_campaigns). Complète get_campaign_statistics pour un audit.",
      parameters: {
        type: "object",
        properties: { workflow_id: { type: "number", description: "workflow_id de la campagne." } },
        required: ["workflow_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_contact_lists",
      description:
        "Liste les listes de contacts du compte (nom, nb de contacts/emails/LinkedIn). Recherche libre optionnelle.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Filtre texte sur le nom (optionnel)." },
          page: { type: "number", description: "Page (défaut 1)." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_contact_list",
      description: "Détail d'une liste de contacts (compteurs, état des jobs) par son id.",
      parameters: {
        type: "object",
        properties: { id: { type: "number", description: "Id de la liste." } },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "query_contacts",
      description:
        "Récupère des contacts d'une liste (champs résolus en clair : first_name, email, company…). Recherche plein-texte optionnelle. Plafonné à 20.",
      parameters: {
        type: "object",
        properties: {
          list_id: { type: "number", description: "Id de la liste." },
          search: { type: "string", description: "Recherche plein-texte (optionnel, >= 2 caractères)." },
        },
        required: ["list_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_contact_fields",
      description: "Liste les champs de données disponibles (nom + identifiant).",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "list_linkedin_accounts",
      description: "Liste les comptes LinkedIn connectés et leur validité / état de checkpoint.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "preview_contact_selection",
      description:
        "Compte les contacts d'une liste correspondant à un filtre, AVANT toute suppression. Ne supprime rien. À appeler en premier pour connaître le nombre exact.",
      parameters: {
        type: "object",
        properties: {
          list_id: { type: "number", description: "Id de la liste." },
          filter: {
            type: "object",
            description:
              "Filtre Magileads : {mode:'and'|'or', values:[{field_name (= data_field_id en string, cf. list_contact_fields), type:'contains'|'equals'|'start_with'|'does_exist'|'does_not_exist', value?}]}. NE PAS envoyer de filtre vide.",
          },
        },
        required: ["list_id", "filter"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_contacts_by_selection",
      description:
        "Supprime DÉFINITIVEMENT les contacts d'une liste correspondant à un filtre. À n'appeler QU'APRÈS preview_contact_selection ET la confirmation explicite de l'utilisateur. confirm_count doit égaler le nombre renvoyé par l'aperçu (sinon la suppression est refusée).",
      parameters: {
        type: "object",
        properties: {
          list_id: { type: "number", description: "Id de la liste." },
          filter: { type: "object", description: "Le MÊME filtre que l'aperçu." },
          confirm_count: {
            type: "number",
            description: "Le nombre exact renvoyé par preview_contact_selection.",
          },
        },
        required: ["list_id", "filter", "confirm_count"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_prm_statuses",
      description: "Statuts du pipeline PRM (CRM) : par défaut + personnalisés.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "query_prm_contacts",
      description:
        "Prospects du PRM (pipeline CRM) : liste avec statut, réponses. Recherche libre optionnelle. Plafonné à 25.",
      parameters: {
        type: "object",
        properties: {
          search: { type: "string", description: "Recherche plein-texte (optionnel)." },
          page: { type: "number", description: "Page (défaut 1)." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_prm_contact",
      description: "Fiche détaillée d'un prospect PRM (statut, appels, réponses, campagnes) par son id.",
      parameters: {
        type: "object",
        properties: { id: { type: "number", description: "Id du contact PRM." } },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_prm_nurturings",
      description: "Séquences de nurturing du PRM.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "run_google_maps_targeting",
      description:
        "Lance un ciblage Google Maps : recherche des établissements par activité + localisations et crée une NOUVELLE liste de contacts (extraction asynchrone, consomme des crédits). Utilise-le pour « cible/trouve des <activité> à <ville> ».",
      parameters: {
        type: "object",
        properties: {
          search: {
            type: "string",
            description: "Activité/mots-clés, ex. « dentistes », « agences immobilières ».",
          },
          locations: {
            type: "array",
            items: { type: "string" },
            description: "Villes/zones, ex. [\"Lyon\",\"Villeurbanne\"]. Optionnel.",
          },
          max_results: { type: "number", description: "Nombre max de contacts (défaut 50, max 200)." },
          list_name: { type: "string", description: "Nom de la liste à créer (optionnel)." },
        },
        required: ["search"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ask_linkedin_account",
      description:
        "Affiche à l'utilisateur une carte cliquable des comptes LinkedIn UTILISABLES (valides, sans checkpoint) pour qu'il en choisisse un, AVANT un ciblage LinkedIn. N'invente jamais de compte : appelle cet outil, il affiche les vrais comptes. Ne liste pas les comptes toi-même.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "run_linkedin_targeting",
      description:
        "Lance un ciblage LinkedIn « recherche de personnes » : cherche des profils par poste/lieu/entreprise avec un compte LinkedIn VALIDE, et crée une liste (extraction asynchrone). N'appelle cet outil qu'APRÈS que l'utilisateur ait choisi un compte (linkedin_account_id) et donné un nom de liste.",
      parameters: {
        type: "object",
        properties: {
          linkedin_account_id: {
            type: "number",
            description: "Id du compte LinkedIn valide choisi par l'utilisateur.",
          },
          list_name: { type: "string", description: "Nom de la liste à créer." },
          title: {
            type: "string",
            description: "Intitulé de poste ciblé, ex. « DAF », « Head of Growth » (optionnel).",
          },
          location: {
            type: "string",
            description:
              "Ville/pays en FRANÇAIS de préférence, ex. « Royaume-Uni », « Londres », « Paris », « France » (optionnel ; évite les abréviations comme « UK »).",
          },
          company: { type: "string", description: "Entreprise actuelle ciblée (optionnel)." },
          max_results: { type: "number", description: "Nombre max de contacts (défaut 100, max 1000)." },
        },
        required: ["linkedin_account_id", "list_name"],
      },
    },
  },
];

/** French label for the streaming tool indicator (the front can reuse this map). */
export const TOOL_LABELS = {
  get_account_overview: "Lecture du compte",
  list_campaigns: "Lecture des campagnes",
  get_campaign_statistics: "Statistiques de campagne",
  get_campaign: "Détail de la campagne",
  list_contact_lists: "Lecture des listes",
  get_contact_list: "Détail de la liste",
  query_contacts: "Lecture des contacts",
  list_contact_fields: "Lecture des champs",
  list_linkedin_accounts: "Comptes LinkedIn",
  preview_contact_selection: "Aperçu de la sélection",
  delete_contacts_by_selection: "Suppression de contacts",
  list_prm_statuses: "Statuts du pipeline",
  query_prm_contacts: "Lecture des prospects",
  get_prm_contact: "Fiche prospect",
  list_prm_nurturings: "Séquences de nurturing",
  run_google_maps_targeting: "Ciblage Google Maps",
  ask_linkedin_account: "Comptes LinkedIn",
  run_linkedin_targeting: "Ciblage LinkedIn",
};

/** Tools that create/fill a contact list → the front can watch for completion. */
export const CREATES_LIST = ["run_google_maps_targeting", "run_linkedin_targeting"];

/* --------------------------------- helpers -------------------------------- */

function statusOf(c) {
  if (c.archived) return "archived";
  if (c.stopped) return "stopped";
  if (c.date_start && new Date(c.date_start).getTime() > Date.now()) return "scheduled";
  return "running";
}

function pct(num, denom) {
  if (!denom || denom <= 0) return null;
  return Math.round(((num ?? 0) / denom) * 100);
}

/**
 * Serialize a tool result, capping size to protect the model context window.
 * MUST always return VALID JSON — slicing a JSON string mid-way corrupts it.
 */
function cap(value, max = 8000) {
  const s = JSON.stringify(value ?? null);
  if (s.length <= max) return s;
  return JSON.stringify({
    _truncated: true,
    _chars: s.length,
    _note: "Résultat trop volumineux — affine ta requête (moins d'éléments).",
    _preview: s.slice(0, 2000),
  });
}

async function fieldMap(auth) {
  const res = await listDataFields(auth);
  const fields = res.ok ? res.data?.data_fields_list ?? [] : [];
  const m = {};
  for (const f of fields) if (f?.id != null) m[String(f.id)] = f.identifier || f.name || String(f.id);
  return m;
}

/** A filter that actually constrains something (never "delete everything"). */
function nonEmptyFilter(f) {
  return !!f && typeof f === "object" && Array.isArray(f.values) && f.values.length > 0;
}

/** Normalize the (ambiguous) contacts envelope -> flat array of contact rows. */
function contactRows(env) {
  const results = Array.isArray(env.results) ? env.results : [];
  const first = results[0];
  if (first && Array.isArray(first.results)) return first.results;
  return results;
}

/* -------------------------------- executor -------------------------------- */

/**
 * Run one tool. Always returns a JSON STRING (already size-capped) for the model.
 * @param {string} name tool name
 * @param {string} argsRaw raw JSON arguments produced by the model
 * @param {{accessToken?:string, apiKey?:string}} auth the CALLER's credentials
 */
export async function executeTool(name, argsRaw, auth) {
  let args = {};
  try {
    args = argsRaw ? JSON.parse(argsRaw) : {};
  } catch {
    return cap({ error: "arguments JSON invalides" });
  }

  try {
    switch (name) {
      case "get_account_overview": {
        const r = await getMe(auth);
        if (!r.ok || !r.data) return cap({ error: "profil indisponible" });
        const p = r.data.user_profile ?? r.data;
        return cap({
          first_name: p.first_name,
          last_name: p.last_name,
          email: p.email,
          id: p.id,
          subscriptions: p.subscriptions ?? null,
          level: p.level ?? null,
          _note: "L'API n'expose pas de solde de crédits numérique.",
        });
      }

      case "list_campaigns": {
        const r = await listProgrammationsStats(auth, {
          page: Number(args.page) || 1,
          query: typeof args.query === "string" ? args.query : undefined,
        });
        if (!r.ok || !r.data) return cap({ error: "campagnes indisponibles" });
        const env = r.data;
        // The array comes under `programmations` (not `results`) and the count under
        // `number_results` — tolerate every observed shape.
        const rows = Array.isArray(env.results)
          ? env.results
          : Array.isArray(env.programmations)
            ? env.programmations
            : Array.isArray(env.data)
              ? env.data
              : [];
        return cap({
          total:
            Number(env.number_of_results ?? env.number_results ?? env.total ?? rows.length) || rows.length,
          total_pages: env.number_of_pages ?? 1,
          campaigns: rows.slice(0, 50).map((c) => ({
            id: c.id,
            workflow_id: c.workflow_id,
            name: c.workflow_name,
            status: statusOf(c),
            contacted: c.contacted ?? 0,
            to_contact: c.to_contact ?? 0,
            open_rate_pct: pct(c.contacts_opened, c.contacted),
            click_rate_pct: pct(c.contacts_clicked, c.contacted),
            reply_rate_pct: pct(c.contacts_answered, c.contacted),
            bounced: c.bounced ?? 0,
            date_start: c.date_start,
            steps: Array.isArray(c.steps) ? c.steps.length : undefined,
          })),
        });
      }

      case "get_campaign_statistics": {
        const id = Number(args.id);
        if (!Number.isFinite(id)) return cap({ error: "id manquant" });
        const r = await getProgrammationStats(auth, id);
        if (!r.ok || !r.data) return cap({ error: "statistiques indisponibles" });
        return cap(r.data, 12000);
      }

      case "get_campaign": {
        const wid = Number(args.workflow_id);
        if (!Number.isFinite(wid)) return cap({ error: "workflow_id manquant" });
        const r = await getWorkflow(auth, wid);
        if (!r.ok || !r.data) return cap({ error: "scénario indisponible" });
        return cap(r.data, 12000);
      }

      case "list_contact_lists": {
        const options = { per_page: 50 };
        if (typeof args.query === "string" && args.query) {
          options.filter = {
            mode: "or",
            values: [{ field_name: "name", type: "contains", value: args.query }],
          };
        }
        const r = await listContactListsPaginated(auth, options, Number(args.page) || 1);
        if (!r.ok || !r.data) return cap({ error: "listes indisponibles" });
        const env = r.data;
        return cap({
          total: env.number_of_results ?? env.results?.length ?? 0,
          total_pages: env.number_of_pages ?? 1,
          lists: (env.results ?? []).slice(0, 50).map((l) => ({
            id: l.id,
            name: l.name,
            contacts: l.number_of_contacts ?? 0,
            emails: l.number_of_emails ?? 0,
            linkedin: l.number_of_linkedin_url ?? 0,
            created_on: l.created_on,
          })),
        });
      }

      case "get_contact_list": {
        const id = Number(args.id);
        if (!Number.isFinite(id)) return cap({ error: "id manquant" });
        const r = await getContactListProfile(auth, id);
        if (!r.ok || !r.data) return cap({ error: "liste introuvable" });
        const p = r.data.contact_list_profile ?? r.data;
        return cap({
          id: p.id,
          name: p.name,
          contacts: p.number_of_contacts ?? 0,
          emails: p.number_of_emails ?? 0,
          linkedin: p.number_of_linkedin_url ?? 0,
          companies: p.number_of_companies ?? 0,
          list_type: p.list_type,
          created_on: p.created_on,
          jobs: (p.state_details ?? []).map((j) => ({ type: j.type, state: j.state, percent: j.percent })),
        });
      }

      case "query_contacts": {
        const id = Number(args.list_id);
        if (!Number.isFinite(id)) return cap({ error: "list_id manquant" });
        const search = typeof args.search === "string" ? args.search.trim() : "";
        const map = await fieldMap(auth);
        const options = { per_page: 25 };
        const r =
          search.length >= 2
            ? await searchContactListContacts(auth, id, search, options)
            : await listContactListContacts(auth, id, options);
        if (!r.ok || !r.data) return cap({ error: "contacts indisponibles" });
        const env = r.data;
        const rows = contactRows(env);
        // Keep only prospection-useful fields, drop hash/geo noise → compact + valid JSON.
        const USEFUL =
          /(e-?mail|first_?name|last_?name|full_?name|nom|prenom|company|entreprise|societe|job|title|poste|fonction|function|city|ville|country|pays|region|phone|tel|mobile|linkedin|website|site)/i;
        const NOISE =
          /(md5|sha\d|hash|_domain|maps|cid|latitude|longitude|coord|opening|hours|_lat|_lng|timezone)/i;
        const contacts = rows.slice(0, 20).map((row) => {
          const props = row.properties ?? [];
          const out = {};
          for (const pr of props) {
            const key = map[String(pr.data_field_id)] ?? String(pr.data_field_id);
            if (pr.value && USEFUL.test(key) && !NOISE.test(key)) out[key] = String(pr.value).slice(0, 140);
          }
          return { id: row.id, ...out };
        });
        return cap({
          total:
            Number(env.number_of_results ?? env.number_of_contacts ?? contacts.length) || contacts.length,
          returned: contacts.length,
          contacts,
        });
      }

      case "list_contact_fields": {
        const r = await listDataFields(auth);
        if (!r.ok || !r.data) return cap({ error: "champs indisponibles" });
        return cap({
          fields: (r.data.data_fields_list ?? []).map((f) => ({
            id: f.id,
            name: f.name,
            identifier: f.identifier,
          })),
        });
      }

      case "list_linkedin_accounts": {
        const r = await listLinkedinAccounts(auth);
        if (!r.ok || !r.data) return cap({ error: "comptes LinkedIn indisponibles" });
        return cap({
          accounts: (r.data.linkedin_accounts_list ?? []).map((a) => ({
            id: a.id,
            name: a.name,
            username: a.username,
            is_valid: a.is_valid,
            checkpoint_required: a.checkpoint_required,
            sales_navigator: a.is_sales_navigator_account,
            last_use: a.last_use,
          })),
        });
      }

      case "list_prm_statuses": {
        const [def, cust] = await Promise.all([listPrmStatuses(auth), listPrmCustomStatuses(auth)]);
        return cap({ default: def.ok ? def.data : null, custom: cust.ok ? cust.data : null });
      }

      case "query_prm_contacts": {
        const search = typeof args.search === "string" ? args.search.trim() : "";
        const options = { per_page: 25 };
        if (search) options.query = search;
        const r = await listPrmContacts(auth, options);
        if (!r.ok || !r.data) return cap({ error: "PRM indisponible" });
        const env = r.data;
        const rows = Array.isArray(env.results) ? env.results : [];
        return cap({
          total: Number(env.number_of_results ?? rows.length) || rows.length,
          contacts: rows.slice(0, 25).map((c) => ({
            id: c.id,
            first_name: c.first_name,
            last_name: c.last_name,
            status: c.status,
            custom_status: c.custom_status,
            is_positive: c.is_positive,
            new_reply: c.new_reply,
          })),
        });
      }

      case "get_prm_contact": {
        const id = Number(args.id);
        if (!Number.isFinite(id)) return cap({ error: "id manquant" });
        const r = await getPrmContact(auth, id);
        if (!r.ok || !r.data) return cap({ error: "prospect PRM introuvable" });
        return cap(r.data, 12000);
      }

      case "list_prm_nurturings": {
        const r = await listPrmNurturings(auth);
        if (!r.ok || !r.data) return cap({ error: "nurturings indisponibles" });
        return cap(r.data);
      }

      case "preview_contact_selection": {
        const id = Number(args.list_id);
        if (!Number.isFinite(id)) return cap({ error: "list_id manquant" });
        if (!nonEmptyFilter(args.filter)) {
          return cap({ error: "filtre vide interdit (empêche une suppression totale accidentelle)" });
        }
        const r = await listContactListContacts(auth, id, { per_page: 1, filter: args.filter });
        if (!r.ok || !r.data) return cap({ error: "aperçu indisponible" });
        const env = r.data;
        const count = Number(env.number_of_results ?? env.number_of_contacts ?? 0) || 0;
        return cap({
          list_id: id,
          count,
          note: "Aucun contact supprimé. Émets le marqueur [[CONFIRM_DELETE]] puis ATTENDS l'accord de l'utilisateur avant de supprimer.",
        });
      }

      case "delete_contacts_by_selection": {
        const id = Number(args.list_id);
        if (!Number.isFinite(id)) return cap({ error: "list_id manquant" });
        if (!nonEmptyFilter(args.filter)) return cap({ error: "filtre vide interdit" });
        const confirm = Number(args.confirm_count);
        if (!Number.isFinite(confirm)) return cap({ error: "confirm_count requis" });
        // Real safety: re-count NOW and refuse if it differs from what was confirmed.
        const pre = await listContactListContacts(auth, id, { per_page: 1, filter: args.filter });
        const actual = Number(pre.data?.number_of_results ?? 0) || 0;
        if (actual !== confirm) {
          return cap({
            error: `Abandon : le filtre correspond maintenant à ${actual} contacts, pas ${confirm}. Refais un aperçu et une confirmation.`,
          });
        }
        const del = await deleteContactsSelection(auth, id, {
          filter: args.filter,
          contact_ids: [],
          excluded_contact_ids: [],
          reverse_selection: false,
        });
        if (!del.ok) return cap({ error: "suppression échouée" });
        return cap({ status: "contacts supprimés", deleted: actual, list_id: id });
      }

      case "run_google_maps_targeting": {
        const search = typeof args.search === "string" ? args.search.trim() : "";
        if (!search) return cap({ error: "paramètre search manquant" });
        const locations = Array.isArray(args.locations)
          ? args.locations.filter((x) => typeof x === "string").slice(0, 10)
          : undefined;
        const maxResults = Math.min(Math.max(Number(args.max_results) || 50, 1), 200);
        const listName =
          typeof args.list_name === "string" && args.list_name.trim()
            ? args.list_name.trim().slice(0, 80)
            : `Ciblage — ${search}`.slice(0, 80);
        const gen = await generateGoogleMapsUrls(auth, {
          search,
          locations,
          max_links: Math.min(Math.max(locations?.length ?? 1, 1) * 2, 10),
        });
        const urls = gen.ok ? gen.data?.google_maps_search_urls ?? [] : [];
        if (!urls.length) return cap({ error: "génération des URLs Google Maps échouée" });
        const ext = await extractGoogleMaps(auth, {
          google_maps_search_urls: urls.slice(0, 10),
          max_results: maxResults,
          contact_list_name: listName,
        });
        if (!ext.ok || !ext.data?.contact_list_id) return cap({ error: "lancement de l'extraction échoué" });
        return cap({
          status: "extraction lancée",
          list_id: ext.data.contact_list_id,
          list_name: listName,
          max_results: maxResults,
          note: "Extraction asynchrone : la liste se remplit en arrière-plan et l'utilisateur sera notifié à la fin. Ne PAS re-lancer.",
        });
      }

      case "ask_linkedin_account": {
        const r = await listLinkedinAccounts(auth);
        if (!r.ok || !r.data) return cap({ error: "comptes LinkedIn indisponibles" });
        // Usable = valid AND no pending checkpoint (a checkpoint account can't extract).
        const usable = (r.data.linkedin_accounts_list ?? [])
          .filter((a) => a.is_valid === true && a.checkpoint_required !== true)
          .map((a) => ({ id: a.id, name: a.name || a.username || `#${a.id}`, username: a.username }));
        if (!usable.length) {
          return cap({
            accounts: [],
            note: "Aucun compte LinkedIn valide et sans checkpoint. Dis à l'utilisateur de connecter/valider un compte dans Comptes LinkedIn.",
          });
        }
        // The SERVER turns THIS real list into the clickable card (never the model's text).
        return cap({
          accounts: usable,
          note: "Carte de sélection affichée à l'utilisateur avec ces comptes. N'énumère PAS les comptes toi-même ; attends que l'utilisateur clique.",
        });
      }

      case "run_linkedin_targeting": {
        const accountId = Number(args.linkedin_account_id);
        if (!Number.isFinite(accountId) || accountId <= 0) {
          return cap({ error: "linkedin_account_id manquant" });
        }
        const listName =
          typeof args.list_name === "string" && args.list_name.trim()
            ? args.list_name.trim().slice(0, 80)
            : "";
        if (!listName) return cap({ error: "list_name manquant" });
        const maxResults = Math.min(Math.max(Number(args.max_results) || 100, 1), 1000);

        // The location API is FRENCH-locale and returns fuzzy GLOBAL matches, so pick
        // the BEST one (exact name, else the broadest = fewest commas) — never blindly
        // the first one ("London" resolves to London, Canada!).
        let locations = [];
        let resolvedLocation;
        if (typeof args.location === "string" && args.location.trim()) {
          const q = args.location.trim();
          const loc = await searchLinkedinLocations(auth, q);
          const cands = loc.ok ? loc.data?.locations ?? [] : [];
          if (!cands.length) {
            // Never silently launch a location-less (worldwide) search.
            return cap({
              error: `Localisation « ${q} » introuvable. Demande à l'utilisateur de préciser, de préférence en FRANÇAIS (ex. « Royaume-Uni », « Londres », « Paris », « France »). Évite les abréviations comme « UK ».`,
            });
          }
          const nm = (l) => (l.name_fr || l.name_en || "").trim();
          const ql = q.toLowerCase();
          const exact = cands.find((c) => nm(c).toLowerCase() === ql);
          const best =
            exact ?? [...cands].sort((a, b) => nm(a).split(",").length - nm(b).split(",").length)[0];
          locations = [best.id];
          resolvedLocation = nm(best) || String(best.id);
        }

        const filters = {};
        if (typeof args.title === "string" && args.title.trim()) filters.current_title = args.title.trim();
        if (typeof args.company === "string" && args.company.trim()) {
          filters.current_company = args.company.trim();
        }
        if (locations.length) filters.locations = locations;
        if (Object.keys(filters).length === 0) {
          return cap({ error: "Précise au moins un critère : poste, lieu ou entreprise." });
        }

        const gen = await generatePeoplesSearchUrl(auth, filters);
        const url = gen.ok ? gen.data?.linkedin_url : undefined;
        if (!url) return cap({ error: "génération de l'URL de recherche LinkedIn échouée" });
        const ext = await linkedinExtract(auth, "extract-peoples-search", {
          linkedin_account_id: accountId,
          contact_list_name: listName,
          max_results: maxResults,
          generate_email: true,
          linkedin_people_search_url: url,
        });
        if (!ext.ok || !ext.data?.contact_list_id) {
          return cap({ error: "lancement de l'extraction LinkedIn échoué" });
        }
        return cap({
          status: "extraction lancée",
          list_id: ext.data.contact_list_id,
          list_name: listName,
          criteria: {
            title: args.title,
            location_requested: args.location,
            location_used: resolvedLocation ?? null,
            company: args.company,
          },
          max_results: maxResults,
          note: "Extraction LinkedIn asynchrone : la liste se remplit en arrière-plan, l'utilisateur sera notifié à la fin. Indique dans ton résumé la localisation RÉELLEMENT utilisée (location_used). Ne PAS re-lancer.",
        });
      }

      default:
        return cap({ error: `outil inconnu: ${name}` });
    }
  } catch {
    return cap({ error: "échec de l'exécution de l'outil" });
  }
}
