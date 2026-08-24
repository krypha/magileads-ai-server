/**
 * Minimal Magileads API client (plain JS, fetch-based — works on Bun and Node 18+).
 *
 * Every call takes the END USER's credentials (`auth`), so the assistant can only
 * ever read/act on the account of whoever is calling. Nothing here is global.
 *
 * `auth` = { accessToken } (Bearer JWT) OR { apiKey } (X-API-Key).
 */

export const API_BASE = (process.env.MAGILEADS_API_BASE || "https://app.api-magileads.net").replace(/\/+$/, "");

/**
 * Auth headers for one caller.
 *
 * We forward BOTH headers when the caller sent both, exactly as the front-end
 * does. That matters for account switching: the React app keeps
 * `Authorization: Bearer <main token>` and adds `X-API-Key: <switched token>`.
 * By passing both through, Magileads applies its own precedence and we act on
 * the same account the rest of the app does — instead of guessing here.
 */
function authHeaders(auth) {
  const h = {};
  if (auth?.accessToken) h.Authorization = `Bearer ${auth.accessToken}`;
  if (auth?.apiKey) h["X-API-Key"] = auth.apiKey;
  return h;
}

/**
 * One HTTP call. NEVER throws: a network failure returns { ok:false, status:0 }
 * so a blip can't crash the stream (same contract as the Next.js app).
 */
async function request(path, { auth, method = "GET", body, headers } = {}) {
  let res;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...authHeaders(auth),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
    });
  } catch {
    return { ok: false, status: 0, data: null, errorKey: "network_error" };
  }

  let data = null;
  const text = await res.text().catch(() => "");
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  const errorKey =
    !res.ok && data && typeof data === "object" ? data.state_message : undefined;
  return { ok: res.ok, status: res.status, data, errorKey };
}

/** `options` is passed as a urlencoded JSON query param (Magileads convention). */
function optionsQuery(options) {
  if (!options || Object.keys(options).length === 0) return "";
  return `?options=${encodeURIComponent(JSON.stringify(options))}`;
}

/* ----------------------------- account / fields ---------------------------- */

export const getMe = (auth) => request("/users/me", { auth });
export const listDataFields = (auth) => request("/data-fields", { auth });

/* --------------------------------- LinkedIn -------------------------------- */

/** Magileads returns { linkedin_accounts_list }, some gateways a bare array. */
export async function listLinkedinAccounts(auth) {
  const r = await request("/integrations/linkedin", { auth });
  if (!r.ok) return r;
  const list = Array.isArray(r.data) ? r.data : r.data?.linkedin_accounts_list ?? [];
  return { ...r, data: { linkedin_accounts_list: list } };
}

export const searchLinkedinLocations = (auth, name) =>
  request("/targeting/linkedin/locations/search", { auth, method: "POST", body: { name } });

export const generatePeoplesSearchUrl = (auth, filters) =>
  request("/targeting/linkedin/generate-peoples-search-url", { auth, method: "POST", body: filters });

export const generateSalesNavSearchUrl = (auth, filters) =>
  request("/targeting/linkedin/generate-sales-navigator-peoples-search-url", {
    auth,
    method: "POST",
    body: filters,
  });

/** Generic LinkedIn extraction (path = endpoint after /targeting/linkedin/). */
export const linkedinExtract = (auth, path, body) =>
  request(`/targeting/linkedin/${path}`, { auth, method: "POST", body });

/* ------------------------------- Google Maps ------------------------------- */

export const generateGoogleMapsUrls = (auth, body) =>
  request("/targeting/google/generate-maps-search-urls", { auth, method: "POST", body });

export const extractGoogleMaps = (auth, body) =>
  request("/targeting/google/extract-maps-search", { auth, method: "POST", body });

/* ----------------------------- lists & contacts ---------------------------- */

export const listContactListsPaginated = (auth, options, page = 1) =>
  request(`/contact-lists-paginated/page/${page}${optionsQuery(options)}`, { auth });

/**
 * TOUTES les listes en un seul appel (non paginé) avec leurs compteurs.
 * Indispensable pour répondre juste à « mes plus grandes listes » : l'endpoint
 * paginé ne trie que par nom/id, donc on ne verrait qu'une page sur N.
 * Mesuré ~5x plus rapide que /contact-lists-paginated.
 */
export const listContactListNames = (auth) => request("/contact-lists/names", { auth });

export const getContactListProfile = (auth, id) => request(`/contact-lists/${id}`, { auth });

export const listContactListContacts = (auth, id, options) =>
  request(`/contact-lists/${id}/contacts${optionsQuery(options)}`, { auth });

export const searchContactListContacts = (auth, id, query, options) =>
  request(`/contact-lists/${id}/contacts/search${optionsQuery(options)}`, {
    auth,
    method: "POST",
    body: { query },
  });

export const deleteContactsSelection = (auth, listId, selection) =>
  request(`/contact-lists/${listId}/contacts`, { auth, method: "DELETE", body: selection });

/* -------------------------- campaigns & statistics ------------------------- */

export function listProgrammationsStats(auth, { page, query } = {}) {
  const qs = new URLSearchParams();
  if (page && page > 1) qs.set("page", String(page));
  if (query) qs.set("query", query);
  const q = qs.toString();
  return request(`/statistics/programmations${q ? `?${q}` : ""}`, { auth });
}

export const getProgrammationStats = (auth, id) => request(`/statistics/programmations/${id}`, { auth });
export const getWorkflow = (auth, workflowId) => request(`/workflows/${workflowId}`, { auth });

/* ------------------------------- PRM (CRM) --------------------------------- */

export const listPrmStatuses = (auth) => request("/prm/status", { auth });
export const listPrmCustomStatuses = (auth) => request("/prm/status/custom", { auth });
export const listPrmContacts = (auth, options) => request(`/prm/contacts${optionsQuery(options)}`, { auth });
export const getPrmContact = (auth, id) => request(`/prm/contact/${id}`, { auth });
export const listPrmNurturings = (auth) => request("/prm/nurturings", { auth });
