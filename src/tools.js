import { sanitize, forbiddenOperation } from './assistant-policy.js';
import { applyConnectionDegrees, CONNECTION_DEGREES_SCHEMA, validConnectionDegrees } from './linkedin-connections.js';
import { usageLimitsEnabled } from './usage-policy.js';
import { createDocument, DOCUMENT_TOOL } from './documents.js';
import { EXTENDED_TOOLS, executeExtended } from './operations.js';
import { CONTACT_COPY_FILTER_SCHEMA, copyContactsToList } from './contact-copy.js';
import { PRM_TOOLS, PRM_TOOL_NAMES, executePrmTool } from './prm.js';
import {
  countDatabase, hasPermission, updateImportTargeting, positiveId, resolveListTarget,
  runDatabase, runSalesNavigator, usableLinkedInAccount, lookupLinkedinLocations, resolveLinkedinLocations, linkedinGenerationFailure,
} from './import-targeting.js';
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
  generatePeoplesSearchUrl,
  linkedinExtract,
  generateGoogleMapsUrls,
  extractGoogleMaps,
  listContactListsPaginated,
  listContactListNames,
  getContactListProfile,
  listContactListContacts,
  searchContactListContacts,
  listProgrammationsStats,
  getProgrammationStats,
  getWorkflow,
  getPrmContact,
  listPrmNurturings,
} from "./magileads.js";

const DATABASE_FILTER_SCHEMA = {
  type: 'object',
  properties: {
    field: { type: 'string', enum: ['job_title', 'contact_location', 'company', 'company_size', 'activity', 'category', 'zip_code', 'naf_code', 'country', 'phone', 'linkedin_url', 'website', 'summary'] },
    contains: { type: 'array', items: { type: 'string' } },
    does_not_contain: { type: 'array', items: { type: 'string' } },
    starts_with: { type: 'array', items: { type: 'string' } },
    does_not_start_with: { type: 'array', items: { type: 'string' } },
    ends_with: { type: 'array', items: { type: 'string' } },
    does_not_end_with: { type: 'array', items: { type: 'string' } },
    exact_match: { type: 'array', items: { type: 'string' } },
    exists: { type: 'boolean' },
  },
  required: ['field'],
  additionalProperties: false,
};

const CONTACT_LIST_QUERY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    query: { type: 'string', description: 'Filtre sur le nom (contient, insensible à la casse). Optionnel.' },
    sort: {
      type: 'string', enum: ['contacts', 'emails', 'linkedin', 'companies', 'recent', 'name'],
      description: 'Tri sur TOUT le compte : compteurs décroissants, recent ou name. Défaut : recent.',
    },
    limit: { type: 'number', description: 'Max 50. Défaut : 20 pour une lecture, 50 pour un choix.' },
    page: { type: 'number', description: 'Page dans le résultat trié (défaut 1).' },
  },
};

export const AI_TOOLS = [
  DOCUMENT_TOOL,
  ...EXTENDED_TOOLS,
  ...PRM_TOOLS,
  {
    type: 'function',
    function: {
      name: 'search_linkedin_locations',
      description: 'Recherche les vraies localisations LinkedIn et leurs noms français/anglais, pour LinkedIn classique et Sales Navigator. Lecture seule : aucun lancement ni création. À utiliser pour vérifier la zone avant de proposer la validation ; demander de choisir si plusieurs lieux différents correspondent.',
      parameters: { type: 'object', additionalProperties: false, required: ['name'], properties: {
        name: { type: 'string', description: 'Ville, région ou pays demandé, 120 caractères maximum.' },
      } },
    },
  },
  {
    type: 'function',
    function: {
      name: 'copy_contacts_to_list',
      description: 'Copier TOUS les contacts correspondant à un filtre vers une liste existante ou nouvelle, sans supprimer ni limiter aux échantillons. Résoudre la source, les champs et la destination ; demander la destination si ambiguë. Copie asynchrone.',
      parameters: { type: 'object', additionalProperties: false, required: ['source_list_id', 'filter'], properties: {
        source_list_id: { type: 'number', description: 'ID réel de la liste source.' },
        filter: CONTACT_COPY_FILTER_SCHEMA,
        destination_list_id: { type: 'number', description: 'ID d’une liste existante du compte. Omettre pour créer une nouvelle liste.' },
        new_list_name: { type: 'string', description: 'Nom explicitement demandé pour la nouvelle liste ; exclusif avec destination_list_id. Sans nom, Magileads nomme la copie.' },
      } },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_targeting',
      description: 'Mode import : publie les critères structurés dès que la cible évolue. Aucun appel Magileads, aucune création. À appeler au début de chaque tour import.',
      parameters: {
        type: 'object',
        properties: {
          source: { type: ['string', 'null'], enum: ['linkedin', 'sales_navigator', 'database', 'google_maps', null] },
          job_titles: { type: 'array', items: { type: 'string' } },
          seniority: { type: 'array', items: { type: 'string' } },
          connection_degrees: CONNECTION_DEGREES_SCHEMA,
          sectors: { type: 'array', items: { type: 'string' } },
          company_size_min: { type: ['number', 'null'] },
          company_size_max: { type: ['number', 'null'] },
          locations: { type: 'array', items: { type: 'string' } },
          companies: { type: 'array', items: { type: 'string' } },
          activity: { type: ['string', 'null'] },
          cities: { type: 'array', items: { type: 'string' } },
          exclusions: { type: 'array', items: { type: 'string' } },
          max_results: { type: ['number', 'null'] },
        },
        required: ['source'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'count_database_targeting',
      description: 'Aperçu non mutatif du nombre de contacts de la base Magileads pour des filtres exacts. En mode import, affiche le compte AVANT la validation.',
      parameters: {
        type: 'object',
        properties: { filters: { type: 'array', items: DATABASE_FILTER_SCHEMA } },
        required: ['filters'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_database_targeting',
      description: 'Lance une extraction de la base Magileads après validation. filters utilise le même schéma que count_database_targeting ; list_name OU contact_list_id.',
      parameters: { type: 'object', properties: {
        filters: { type: 'array', items: DATABASE_FILTER_SCHEMA },
        list_name: { type: 'string' }, contact_list_id: { type: 'number' }, max_results: { type: 'number', description: 'Défaut 100, max 10000.' },
      }, required: ['filters'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_sales_navigator_targeting',
      description: 'Lance une extraction Sales Navigator après validation. Secteurs, tranches et niveaux sont vérifiés dans l’URL générée. Nécessite un compte Sales Navigator valide et list_name OU contact_list_id.',
      parameters: { type: 'object', properties: {
        titles: { type: 'array', items: { type: 'string' } },
        locations: { type: 'array', items: { type: 'string' }, description: 'Noms de zones en français ; résolus en ID par Magileads.' },
        industries: { type: 'array', items: { type: 'string' }, description: 'Noms exacts de secteurs ou IDs du catalogue Magileads.' },
        companies: { type: 'array', items: { type: 'string' } },
        company_head_counts: { type: 'array', items: { type: 'string', enum: ['independant', '1-10', '11-50', '51-200', '201-500', '501-1000', '1001-5000', '5001-10000', '10001-above'] } },
        seniority_levels: { type: 'array', items: { type: 'string', enum: ['in_training', 'entry_level', 'senior', 'strategic', 'entry_level_manager', 'experienced_manager', 'director', 'vice_president', 'cxo', 'owner_partner'] } },
        connection_degrees: CONNECTION_DEGREES_SCHEMA,
        linkedin_account_id: { type: 'number' }, list_name: { type: 'string' }, contact_list_id: { type: 'number' },
        max_results: { type: 'number', description: 'Défaut 100, max 1000.' }, generate_email: { type: 'boolean', description: 'Défaut true.' },
      }, required: ['linkedin_account_id'] },
    },
  },
  {
    type: "function",
    function: {
      name: "get_account_overview",
      description:
        "Profil du compte Magileads connecté (nom, email, abonnement). Pas de solde de crédits exposé par l'API.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "list_campaigns",
      description:
        "Lit les campagnes (programmations) du compte avec leurs statistiques, SANS carte visible. Pour faire choisir une campagne à l'utilisateur, utilise ask_campaign.",
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
      name: "ask_campaign",
      description:
        "Affiche des campagnes dans un menu déroulant avec recherche par nom ou ID et bouton Valider UNIQUEMENT lorsque l'utilisateur doit choisir une campagne : cible non précisée, nom ambigu ou demande explicite de sélection. Attends son choix. Ne l'utilise pas pour un classement, un audit ou une campagne déjà identifiée.",
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
        "Lecture des listes, SANS carte visible. Balaie TOUTES les listes : tri, recherche et totaux portent sur l'intégralité du compte. Utilise sort=\"contacts\" pour « mes plus grandes listes ». Pour faire choisir une liste à l'utilisateur, utilise ask_contact_list.",
      parameters: CONTACT_LIST_QUERY_SCHEMA,
    },
  },
  {
    type: 'function',
    function: {
      name: 'ask_contact_list',
      description: 'Afficher les vraies listes du compte dans un menu déroulant avec recherche par nom ou ID et bouton Valider UNIQUEMENT quand l’utilisateur doit choisir une liste : demande explicite de sélection, cible non précisée ou noms ambigus. Attendre son choix. Ne pas appeler pour lire/analyser une liste déjà désignée, afficher un classement ou annoncer le résultat d’une action.',
      parameters: CONTACT_LIST_QUERY_SCHEMA,
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
      description: "Liste les champs de données disponibles : ID numérique à utiliser dans field_name, nom, identifier et valeurs possibles réellement stockées.",
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
        "Compte les contacts d'une liste correspondant à un filtre, pour dimensionner un segment. Lecture seule : ne modifie rien.",
      parameters: {
        type: "object",
        properties: {
          list_id: { type: "number", description: "Id de la liste." },
          filter: {
            type: "object",
            description:
              "Filtre Magileads : field_name est l’ID numérique renvoyé par list_contact_fields en texte (ex. '7'), JAMAIS le nom ni l’identifier (ex. 'civility'). NE PAS envoyer de filtre vide.",
            properties: {
              mode: { type: 'string', enum: ['and', 'or'] },
              values: { type: 'array', minItems: 1, items: {
                type: 'object',
                description: 'Condition avec field_name, type, value ; ou groupe imbriqué avec mode et values.',
                properties: {
                  field_name: { type: 'string', pattern: '^[1-9][0-9]*$', description: 'ID numérique du champ en texte, ex. "7".' },
                  type: { type: 'string' }, value: { type: 'string' },
                  mode: { type: 'string', enum: ['and', 'or'] }, values: { type: 'array', minItems: 1, items: { type: 'object' } },
                },
              } },
            },
            required: ['mode', 'values'],
          },
        },
        required: ["list_id", "filter"],
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
        "Lance un ciblage Google Maps : recherche des établissements par activité + localisations et crée ou alimente une liste de contacts (extraction asynchrone, consomme des crédits). Utilise-le pour « cible/trouve des <activité> à <ville> ».",
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
          contact_list_id: { type: 'number', description: 'ID d’une liste existante à alimenter, à la place de list_name.' },
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
        "Affiche à l'utilisateur un menu déroulant recherchable avec bouton Valider des comptes LinkedIn UTILISABLES (valides, sans checkpoint) pour qu'il en choisisse un, AVANT un ciblage LinkedIn. N'invente jamais de compte : appelle cet outil, il affiche les vrais comptes. Ne liste pas les comptes toi-même.",
      parameters: { type: "object", properties: { sales_navigator_only: { type: 'boolean', description: 'true pour ne montrer que les comptes Sales Navigator valides.' } } },
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
          list_name: { type: "string", description: "Nom de la liste à créer ; exclusif avec contact_list_id." },
          contact_list_id: { type: 'number', description: 'ID d’une liste existante à alimenter, à la place de list_name.' },
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
          connection_degrees: CONNECTION_DEGREES_SCHEMA,
          max_results: { type: "number", description: "Nombre max de contacts (défaut 100, max 1000)." },
        },
        required: ["linkedin_account_id"],
      },
    },
  },
];

/** French label for the streaming tool indicator (the front can reuse this map). */
export const TOOL_LABELS = {
  create_document: "Préparation du document",
  discover_operations: "Recherche des fonctions disponibles",
  run_operation: "Exécution de l’action demandée",
  connect_email: "Connexion email sécurisée",
  open_commercial_form: "Formulaire sécurisé",
  add_contact_to_list: "Ajout du contact",
  list_saved_filters: "Filtres sauvegardés",
  find_sharing_users: "Recherche du destinataire",
  share_resource: "Partage de la ressource",
  set_workflow_responder_exclusion: "Exclusion des répondeurs",
  list_prm_reminders: "Rappels du prospect",
  copy_prm_to_blacklist: "Copie vers la blacklist",
  list_dropcontact_connections: "Connexions Dropcontact",
  get_account_overview: "Lecture du compte",
  list_campaigns: "Lecture des campagnes",
  ask_campaign: "Choix de campagne",
  get_campaign_statistics: "Statistiques de campagne",
  get_campaign: "Détail de la campagne",
  list_contact_lists: "Lecture des listes",
  ask_contact_list: "Choix de la liste",
  get_contact_list: "Détail de la liste",
  query_contacts: "Lecture des contacts",
  list_contact_fields: "Lecture des champs",
  list_linkedin_accounts: "Comptes LinkedIn",
  preview_contact_selection: "Comptage de la sélection",
  copy_contacts_to_list: 'Copie des contacts filtrés',
  list_prm_statuses: "Statuts du pipeline",
  list_prm_pipelines: "Lecture des PRM accessibles",
  count_prm_contacts: "Comptage des prospects PRM",
  query_prm_contacts: "Lecture des prospects",
  get_prm_contact: "Fiche prospect",
  list_prm_nurturings: "Séquences de nurturing",
  run_google_maps_targeting: "Ciblage Google Maps",
  update_targeting: 'Mise à jour de la cible',
  search_linkedin_locations: 'Recherche des localisations LinkedIn',
  count_database_targeting: 'Comptage',
  run_database_targeting: 'Base Magileads',
  run_sales_navigator_targeting: 'Ciblage Sales Navigator',
  ask_linkedin_account: "Comptes LinkedIn",
  run_linkedin_targeting: "Ciblage LinkedIn",
};

/** Tools that create/fill a contact list → the front can watch for completion. */
export const CREATES_LIST = ["run_google_maps_targeting", "run_linkedin_targeting", "run_sales_navigator_targeting", "run_database_targeting", 'copy_contacts_to_list'];

export function createsListForTool(name, argsRaw = '{}') {
  if (CREATES_LIST.includes(name)) return true;
  try { return name === 'run_operation' && JSON.parse(argsRaw).operation === 'copy_contacts_to_list'; } catch { return false; }
}

/* --------------------------------- helpers -------------------------------- */

function statusOf(c) {
  if (c.archived) return "archived";
  if (c.stopped) return "stopped";
  if (c.date_start && new Date(c.date_start).getTime() > Date.now()) return "scheduled";
  return "running";
}

function pct(num, denom) {
  if (num == null || !denom || denom <= 0) return null;
  return Math.round((num / denom) * 1000) / 10;
}

/**
 * Sanitize a tool result, then cap size only when usage limits are enabled.
 * MUST always return VALID JSON — slicing a JSON string mid-way corrupts it.
 */
function serializeResult(value, max = 8000, enforceLimits = true) {
  const s = JSON.stringify(sanitize(value ?? null) ?? null);
  if (!enforceLimits || s.length <= max) return s;
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

function numericContactFields(filter) {
  return nonEmptyFilter(filter) && filter.values.every(condition => condition && typeof condition === 'object' &&
    (condition.field_name !== undefined ? /^[1-9][0-9]*$/.test(String(condition.field_name)) : numericContactFields(condition)));
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
 * Run one tool. Always returns sanitized JSON; test mode preserves its full size.
 * @param {string} name tool name
 * @param {string} argsRaw raw JSON arguments produced by the model
 * @param {{accessToken?:string, apiKey?:string}} auth the CALLER's credentials
 */
export async function executeTool(name, argsRaw, auth, context = {}) {
  // The server fixes this policy at chat start. Never use model arguments to
  // select it; direct callers default to the deployment's temporary test mode.
  const enforceLimits = context.enforceUsageLimits ?? usageLimitsEnabled();
  const cap = (value, max) => serializeResult(value, max, enforceLimits);
  if (forbiddenOperation(name) || !AI_TOOLS.some(tool => tool.function.name === name)) return cap({ error: "operation_not_allowed" });
  let args = {};
  try {
    args = argsRaw ? JSON.parse(argsRaw) : {};
  } catch {
    return cap({ error: "arguments JSON invalides" });
  }

  try {
    if (!args || typeof args !== "object" || Array.isArray(args)) return cap({ error: "invalid_arguments" });
    // Documents are already validated and sanitized, and transmitted as a card.
    // Do not truncate their contents into a preview that cannot be downloaded.
    if (name === 'create_document') return JSON.stringify(createDocument(args));
    if (name === 'search_linkedin_locations') return cap(await lookupLinkedinLocations(args.name, auth));
    if (name === 'copy_contacts_to_list') return cap(await copyContactsToList(args, auth, context), 32000);
    if (name === 'update_targeting') {
      context.targeting = updateImportTargeting(args, context.targeting);
      return cap(context.targeting);
    }
    if (PRM_TOOL_NAMES.has(name)) return cap(await executePrmTool(name, args, auth, context), 12000);
    if (name === 'count_database_targeting' || name === 'run_database_targeting' || name === 'run_sales_navigator_targeting') {
      const me = context.profile ? { ok: true, data: { user_profile: context.profile } } : await getMe(auth);
      if (!me.ok) return cap({ error: 'profil indisponible' });
      const profile = me.data?.user_profile ?? me.data;
      const result = name === 'count_database_targeting' ? await countDatabase(args, auth, profile)
        : name === 'run_database_targeting' ? await runDatabase(args, auth, profile)
          : await runSalesNavigator(args, auth, profile);
      return cap(result, result.list_id ? 32000 : 12000);
    }
    const extended = await executeExtended(name, args, auth, context);
    if (extended !== null) return cap(extended, name === "discover_operations" ? 50000 : 12000);
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

      case "ask_campaign":
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
            contacted: c.contacted ?? null,
            to_contact: c.to_contact ?? 0,
            open_rate_pct: pct(c.contacts_opened, c.contacted),
            click_rate_pct: pct(c.contacts_clicked, c.contacted),
            reply_rate_pct: pct(c.contacts_answered, c.contacted),
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

      case "ask_contact_list":
      case "list_contact_lists": {
        const limit = Math.min(Math.max(Number(args.limit) || (name === 'ask_contact_list' ? 50 : 20), 1), 50);
        const page = Math.max(Number(args.page) || 1, 1);
        const query = typeof args.query === "string" ? args.query.trim().toLowerCase() : "";
        const sort = typeof args.sort === "string" ? args.sort : "recent";

        // /contact-lists/names renvoie TOUTES les listes d'un coup (non paginé) et
        // plus vite que l'endpoint paginé : c'est ce qui permet un classement exact
        // « les plus grandes listes » au lieu d'un tri sur une seule page.
        const all = await listContactListNames(auth);
        if (all.ok && Array.isArray(all.data?.contact_lists)) {
          let rows = all.data.contact_lists.map((l) => ({
            id: l.id,
            name: l.name,
            contacts: l.number_of_contacts ?? 0,
            emails: l.number_of_emails ?? 0,
            linkedin: l.number_of_linkedin_url ?? 0,
            companies: l.number_of_companies ?? 0,
            list_type: l.list_type,
            created_on: l.created_on,
          }));
          const totalLists = rows.length;
          const totalContacts = rows.reduce((n, l) => n + (l.contacts || 0), 0);

          if (query) rows = rows.filter((l) => String(l.name ?? "").toLowerCase().includes(query));
          const matched = rows.length;

          const byDesc = (k) => (a, b) => (b[k] || 0) - (a[k] || 0);
          if (sort === "contacts") rows.sort(byDesc("contacts"));
          else if (sort === "emails") rows.sort(byDesc("emails"));
          else if (sort === "linkedin") rows.sort(byDesc("linkedin"));
          else if (sort === "companies") rows.sort(byDesc("companies"));
          else if (sort === "name") rows.sort((a, b) => String(a.name).localeCompare(String(b.name), "fr"));
          else rows.sort((a, b) => (b.id || 0) - (a.id || 0)); // recent

          const start = (page - 1) * limit;
          return cap({
            scope: "TOUTES les listes du compte (non paginé) — le classement est donc exact",
            total_lists: totalLists,
            total_contacts: totalContacts,
            matched,
            sorted_by: sort,
            page,
            total_pages: Math.max(Math.ceil(matched / limit), 1),
            lists: rows.slice(start, start + limit),
          });
        }

        // Repli : ancien endpoint paginé (tri limité à name/id, une page à la fois).
        const options = { per_page: 50 };
        if (query) {
          options.filter = {
            mode: "or",
            values: [{ field_name: "name", type: "contains", value: args.query }],
          };
        }
        const r = await listContactListsPaginated(auth, options, page);
        if (!r.ok || !r.data) return cap({ error: "listes indisponibles" });
        const env = r.data;
        return cap({
          scope: "UNE page seulement (repli) — un classement global n'est pas garanti",
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
            possible_values: Array.isArray(f.possible_values) ? f.possible_values.filter(value => typeof value === 'string') : [],
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
        if (!numericContactFields(args.filter)) {
          return cap({ error: 'field_name doit être l’ID numérique du champ en texte (ex. "7") renvoyé par list_contact_fields, jamais son nom ni son identifier. Corrige le filtre avant de recompter.' });
        }
        const r = await listContactListContacts(auth, id, { per_page: 1, filter: args.filter });
        if (!r.ok || !r.data) return cap({ error: "aperçu indisponible" });
        const env = r.data;
        const count = Number(env.number_of_results ?? env.number_of_contacts ?? 0) || 0;
        return cap({
          list_id: id,
          count,
          note: "Lecture seule : aucune modification. Ce comptage peut servir à une copie filtrée ou à une proposition de suppression. La suppression est réalisée par le front seulement après aperçu et confirmation humaine.",
        });
      }

      case "run_google_maps_targeting": {
        const search = typeof args.search === "string" ? args.search.trim() : "";
        if (!search) return cap({ error: "paramètre search manquant" });
        const locations = Array.isArray(args.locations)
          ? args.locations.filter((x) => typeof x === "string").slice(0, 10)
          : undefined;
        const maxResults = Math.min(Math.max(Math.trunc(Number(args.max_results)) || 50, 1), 200);
        const target = await resolveListTarget({ ...args, list_name: args.list_name ||
          (args.contact_list_id == null ? `Ciblage — ${search}` : undefined) }, auth);
        if (target.error) return cap(target);
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
          ...target.payload,
        });
        const resultId = positiveId(ext.data?.contact_list_id) ?? (ext.ok ? target.id : null);
        if (!ext.ok || !resultId) return cap({
          error: target.id ? 'Google Maps n’a pas accepté la liste existante ; aucune nouvelle liste de remplacement n’a été créée.' : "lancement de l'extraction échoué",
          status_code: ext.status,
        });
        return cap({
          status: "extraction lancée",
          list_id: resultId,
          list_name: target.name,
          criteria_applied: { activity: search, locations_requested: locations ?? [], google_maps_search_urls: urls.slice(0, 10), max_results: maxResults, ignored_filters: [] },
          note: "Extraction asynchrone : la liste se remplit en arrière-plan et l'utilisateur sera notifié à la fin. Ne PAS re-lancer.",
        });
      }

      case "ask_linkedin_account": {
        const salesOnly = args.sales_navigator_only === true;
        if (salesOnly) {
          const me = context.profile ? { ok: true, data: { user_profile: context.profile } } : await getMe(auth);
          if (!me.ok || !hasPermission(me.data?.user_profile ?? me.data, 'accessSearchAI')) {
            return cap({ accounts: [], note: 'Recherche Sales Navigator non autorisée pour ce compte.' });
          }
        }
        const r = await listLinkedinAccounts(auth);
        if (!r.ok || !r.data) return cap({ error: "comptes LinkedIn indisponibles" });
        // Usable = valid AND no pending checkpoint (a checkpoint account can't extract).
        const usable = (r.data.linkedin_accounts_list ?? [])
          .filter((a) => a.is_valid === true && a.checkpoint_required !== true &&
            (!salesOnly || a.is_sales_navigator_account === true))
          // `sales_navigator` so the import form can run a LinkedIn target
          // through Sales Navigator when that is the account the user picked.
          .map((a) => ({ id: a.id, name: a.name || a.username || `#${a.id}`, username: a.username, sales_navigator: a.is_sales_navigator_account === true }));
        if (!usable.length) {
          return cap({
            accounts: [],
            note: salesOnly ? 'Aucun compte Sales Navigator valide et sans checkpoint.' : "Aucun compte LinkedIn valide et sans checkpoint. Dis à l'utilisateur de connecter/valider un compte dans Comptes LinkedIn.",
          });
        }
        // The SERVER supplies these real accounts to the frontend picker (never the model's text).
        return cap({
          accounts: usable,
          note: "Menu déroulant avec recherche et bouton Valider affiché à l'utilisateur avec ces comptes. N'énumère PAS les comptes toi-même ; attends qu'il sélectionne et valide son compte.",
        });
      }

      case "run_linkedin_targeting": {
        if (!validConnectionDegrees(args.connection_degrees)) return cap({ error: 'Niveaux de connexion invalides : utiliser 1, 2 ou 3.' });
        const accountId = Number(args.linkedin_account_id);
        if (!Number.isFinite(accountId) || accountId <= 0) {
          return cap({ error: "linkedin_account_id manquant" });
        }
        const account = await usableLinkedInAccount(auth, accountId);
        if (account.error) return cap(account);
        const target = await resolveListTarget(args, auth);
        if (target.error) return cap(target);
        const maxResults = Math.min(Math.max(Math.trunc(Number(args.max_results)) || 100, 1), 1000);

        // Share the verified bilingual resolution with Sales Navigator.
        // Ambiguous places require a choice; an API error is not an unknown place.
        let locations = [];
        let resolvedLocation;
        if (typeof args.location === "string" && args.location.trim()) {
          const resolved = await resolveLinkedinLocations([args.location.trim()], auth);
          if (resolved.error) return cap(resolved);
          locations = resolved.locations.map(item => item.id);
          resolvedLocation = resolved.locations[0]?.used;
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
        let url = gen.ok ? gen.data?.linkedin_url : undefined;
        if (!url) return cap(linkedinGenerationFailure(gen, 'LinkedIn'));
        const connectionFilter = applyConnectionDegrees(url, args.connection_degrees);
        if (connectionFilter.error) return cap(connectionFilter);
        url = connectionFilter.url;
        const ext = await linkedinExtract(auth, "extract-peoples-search", {
          linkedin_account_id: accountId,
          ...target.payload,
          max_results: maxResults,
          generate_email: true,
          linkedin_people_search_url: url,
        });
        const resultId = positiveId(ext.data?.contact_list_id) ?? (ext.ok ? target.id : null);
        if (!ext.ok || !resultId) {
          return cap({ error: "lancement de l'extraction LinkedIn échoué" });
        }
        return cap({
          status: "extraction lancée",
          list_id: resultId,
          list_name: target.name,
          criteria_applied: {
            title: args.title,
            location_requested: args.location,
            location_used: resolvedLocation ?? null,
            connection_degrees: connectionFilter.degrees,
            company: args.company,
            linkedin_account_id: accountId,
            max_results: maxResults,
            ignored_filters: [],
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
