import { normalizeTargeting, positiveId, validateDatabaseFilters } from './import-targeting.js';

const RUN_TOOL = {
  google_maps: 'run_google_maps_targeting',
  linkedin: 'run_linkedin_targeting',
  sales_navigator: 'run_sales_navigator_targeting',
  database: 'run_database_targeting',
};

/** A confirmed UI form is data, not a model instruction. Validate it again here. */
export function parseImportApproval(submitted) {
  if (!submitted || typeof submitted !== 'object' || Array.isArray(submitted)) return null;
  const name = typeof submitted.list_name === 'string' ? submitted.list_name.trim() : null;
  const listId = submitted.contact_list_id == null ? null : positiveId(submitted.contact_list_id);
  if (Boolean(name) === Boolean(listId) || (name && name.length > 80)) return null;
  if (submitted.contact_list_id != null && listId === null) return null;

  let criteria = null;
  let filters = null;
  let accountId = null;
  if (submitted.targeting != null) {
    if (typeof submitted.targeting !== 'object' || Array.isArray(submitted.targeting)) return null;
    criteria = normalizeTargeting(submitted.targeting);
    if (!criteria.ready_to_launch ||
      (submitted.targeting.max_results != null && submitted.targeting.max_results !== criteria.max_results)) return null;
    if (criteria.source === 'database') {
      const valid = validateDatabaseFilters(submitted.filters);
      if (valid.error) return null;
      filters = valid.filters;
    }
    if (criteria.source === 'linkedin' || criteria.source === 'sales_navigator') {
      accountId = positiveId(submitted.linkedin_account_id);
      if (!accountId) return null;
    }
  } else if (submitted.filters != null || submitted.linkedin_account_id != null) {
    return null;
  }
  return { name, listId, criteria, filters, accountId };
}

export function approvedRunTool(approval) {
  return approval?.criteria ? RUN_TOOL[approval.criteria.source] : null;
}

/** Override fields the model must not change after the user reviewed the form. */
export function approvedToolArgs(name, raw, approval) {
  if (name === 'update_targeting' && approval?.criteria) return JSON.stringify(approval.criteria);
  let args;
  try { args = JSON.parse(raw || '{}'); } catch { return null; }
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null;
  if (name === 'count_database_targeting' && approval?.filters) {
    return JSON.stringify({ filters: approval.filters });
  }
  if (!name.startsWith('run_') || !approval) return JSON.stringify(args);
  if (approval.criteria && name !== approvedRunTool(approval)) return null;

  if (approval.listId != null) {
    delete args.list_name;
    args.contact_list_id = approval.listId;
  } else {
    delete args.contact_list_id;
    args.list_name = approval.name;
  }
  const criteria = approval.criteria;
  if (criteria) {
    if (criteria.max_results != null) args.max_results = criteria.max_results;
    if (criteria.source === 'google_maps') {
      args.search = criteria.activity;
      args.locations = criteria.cities;
    } else if (criteria.source === 'linkedin') {
      args.title = criteria.job_titles[0] ?? '';
      args.location = criteria.locations[0] ?? '';
      args.company = criteria.companies[0] ?? '';
      args.linkedin_account_id = approval.accountId;
    } else if (criteria.source === 'sales_navigator') {
      args.titles = criteria.job_titles;
      args.locations = criteria.locations;
      args.industries = criteria.sectors;
      args.companies = criteria.companies;
      args.seniority_levels = criteria.seniority;
      args.linkedin_account_id = approval.accountId;
    } else if (criteria.source === 'database') {
      args.filters = approval.filters;
    }
  }
  return JSON.stringify(args);
}
