// Per-request workload policy only: no topic classifier or persisted account data.
export class IncludedWorkload {
  constructor() {
    this.calls = 0;
    this.campaigns = new Set();
    this.workflowCampaigns = new Map();
  }

  check(name, raw) {
    if (++this.calls > 12) return 'request_too_broad';
    let args;
    try { args = JSON.parse(raw || '{}'); } catch { return null; }
    if (!args || typeof args !== 'object') return null;
    const ids = [];
    if (name === 'get_campaign_statistics') ids.push(`campaign:${args.id}`);
    if (name === 'get_campaign') ids.push(this.workflowCampaigns.get(String(args.workflow_id)) ?? `workflow:${args.workflow_id}`);
    if (name === 'run_operation') {
      if (['get_period_reporting', 'get_daily_reporting'].includes(args.operation)) {
        const selected = args.body?.limit_to_programmation_ids;
        if (!Array.isArray(selected) || !selected.length || selected.length > 3) return 'request_too_broad';
        ids.push(...selected.map(id => `campaign:${id}`));
      }
      if (args.operation === 'get_campaign_schedule') ids.push(`campaign:${args.params?.id}`);
    }
    const next = new Set([...this.campaigns, ...ids]);
    if (next.size > 3) return 'request_too_broad';
    this.campaigns = next;
    return null;
  }

  observe(name, raw) {
    if (name !== 'list_campaigns' && name !== 'ask_campaign') return;
    try {
      for (const campaign of JSON.parse(raw).campaigns ?? []) {
        if (campaign.id != null && campaign.workflow_id != null) {
          this.workflowCampaigns.set(String(campaign.workflow_id), `campaign:${campaign.id}`);
        }
      }
    } catch { /* Failed tools do not provide trusted campaign mappings. */ }
  }
}
