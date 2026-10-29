import type { CampaignEntity, AdConnection } from './workspace';

export interface DailyInsight {
  connection_id: string;
  ad_id: string;
  date: string;
  spend: number;
  impressions: number;
  clicks: number;
  messaging: number;
}
export interface ReportContact {
  id: string;
  name: string;
  ctwa_source_id: string | null;
  created_at: string;
}
export interface Qualification {
  id: string;
  contact_id: string;
  status: string;
  reason: string;
  source: string;
  occurred_at: string;
}
export interface Sale {
  id: string;
  contact_id: string;
  deal_id: string | null;
  value: number;
  currency: string;
  source: string;
  status: string;
  occurred_at: string;
}
export interface ConversationMilestone {
  ads_customer_messages?: number;
  contact_id: string;
  ads_first_customer_at: string | null;
  ads_first_human_at: string | null;
  ads_first_bot_at: string | null;
  last_message_sender_type: string | null;
  status: string;
}
export interface FlowJourney {
  id: string;
  contact_id: string;
  flow_id: string;
  status: string;
  current_node_key: string | null;
  started_at: string;
  ended_at: string | null;
  follow_up_attempts: number;
}
export interface CampaignMetrics {
  id: string;
  name: string;
  status: string;
  spend: number;
  impressions: number;
  clicks: number;
  messaging: number;
  leads: number;
  qualified: number;
  customers: number;
  revenue: number;
  cpl: number | null;
  cpql: number | null;
  cpa: number | null;
  roas: number | null;
  ctr: number | null;
  dailyBudget: number | null;
  budgetBaseline: number | null;
  currencyMismatch: boolean;
}
export function moneyScale(currency: string) {
  return (
    10 **
    (new Intl.NumberFormat('en', {
      style: 'currency',
      currency,
    }).resolvedOptions().maximumFractionDigits || 0)
  );
}
export function dayInZone(value: string, zone: string) {
  return new Date(value).toLocaleDateString('en-CA', { timeZone: zone });
}
export function formatAdMoney(value: number, currency: string) {
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency }).format(
      value
    );
  } catch {
    return `${currency} ${value.toFixed(2)}`;
  }
}
export function previousPeriod(start: string, end: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end))
    throw Error('Choose valid calendar dates');
  const from = Date.parse(start + 'T00:00:00Z'),
    to = Date.parse(end + 'T00:00:00Z');
  if (
    !Number.isFinite(from) ||
    !Number.isFinite(to) ||
    from > to ||
    new Date(from).toISOString().slice(0, 10) !== start ||
    new Date(to).toISOString().slice(0, 10) !== end ||
    to - from > 366 * 86400_000
  )
    throw Error('Choose an inclusive reporting range of at most 367 days');
  return {
    start: new Date(from - (to - from) - 86400_000).toISOString().slice(0, 10),
    end: new Date(from - 86400_000).toISOString().slice(0, 10),
  };
}
export function campaignReport(input: {
  connection: AdConnection;
  entities: CampaignEntity[];
  insights: DailyInsight[];
  contacts: ReportContact[];
  clicks: {
    contact_id: string | null;
    ad_id: string | null;
    occurred_at: string;
  }[];
  qualifications: Qualification[];
  sales: Sale[];
  conversations: ConversationMilestone[];
  flows?: FlowJourney[];
  start: string;
  end: string;
}) {
  const { connection, entities, start, end } = input;
  const inPeriod = (date: string) => date >= start && date <= end;
  const day = (date: string) => dayInZone(date, connection.timezone);
  const adsets = new Map(
    entities.filter((e) => e.kind === 'adset').map((e) => [e.meta_id, e])
  );
  const ads = new Map(
    entities.filter((e) => e.kind === 'ad').map((e) => [e.meta_id, e])
  );
  const campaigns = entities.filter((e) => e.kind === 'campaign');
  const firstClicks = new Map<string, (typeof input.clicks)[number]>();
  for (const click of input.clicks)
    if (click.contact_id && click.ad_id) {
      const old = firstClicks.get(click.contact_id);
      if (!old || old.occurred_at > click.occurred_at)
        firstClicks.set(click.contact_id, click);
    }
  let fallbackLeads = 0;
  const leadSources = new Map<string, string>();
  for (const c of input.contacts) {
    const click = firstClicks.get(c.id);
    const original =
      click &&
      Date.parse(click.occurred_at) <= Date.parse(c.created_at) + 300_000
        ? click.ad_id
        : null;
    const ad = original || c.ctwa_source_id;
    if (ad && ads.has(ad)) {
      leadSources.set(c.id, ad);
      if (!original && inPeriod(day(c.created_at))) fallbackLeads++;
    }
  }
  const campaignForAd = (adId: string) =>
    adsets.get(ads.get(adId)?.parent_id || '')?.parent_id;
  const campaignForContact = (id: string) =>
    campaignForAd(leadSources.get(id) || '');
  const latestQualifications = new Map<string, Qualification>();
  for (const q of input.qualifications.filter(
    (q) => day(q.occurred_at) <= end
  )) {
    const prev = latestQualifications.get(q.contact_id);
    if (!prev || prev.occurred_at < q.occurred_at)
      latestQualifications.set(q.contact_id, q);
  }
  const groupForAd = (ad: string, kind: string) =>
    kind === 'ad'
      ? ad
      : kind === 'adset'
        ? ads.get(ad)?.parent_id
        : campaignForAd(ad);
  const total = (id: string | null, kind = 'campaign'): CampaignMetrics => {
    const entity = entities.find((c) => c.meta_id === id && c.kind === kind);
    const series = input.insights.filter(
      (i) => inPeriod(i.date) && (!id || groupForAd(i.ad_id, kind) === id)
    );
    const leads = input.contacts.filter(
      (c) =>
        leadSources.has(c.id) &&
        inPeriod(day(c.created_at)) &&
        (!id || groupForAd(leadSources.get(c.id) || '', kind) === id)
    );
    const qualified = [...latestQualifications.values()].filter(
      (q) =>
        q.status === 'qualified' &&
        leadSources.has(q.contact_id) &&
        inPeriod(day(q.occurred_at)) &&
        (!id || groupForAd(leadSources.get(q.contact_id) || '', kind) === id)
    );
    const sales = input.sales.filter(
      (s) =>
        s.status === 'confirmed' &&
        leadSources.has(s.contact_id) &&
        inPeriod(day(s.occurred_at)) &&
        (!id || groupForAd(leadSources.get(s.contact_id) || '', kind) === id)
    );
    const spend = series.reduce((n, i) => n + Number(i.spend), 0);
    const impressions = series.reduce((n, i) => n + Number(i.impressions), 0);
    const clicks = series.reduce((n, i) => n + Number(i.clicks), 0);
    const currencyMismatch = sales.some(
      (s) => s.currency !== connection.currency
    );
    const revenue = sales
      .filter((s) => s.currency === connection.currency)
      .reduce((n, s) => n + Number(s.value), 0);
    const customers = new Set(sales.map((s) => s.contact_id)).size;
    const budget = entity?.data.daily_budget
      ? Number(entity.data.daily_budget) / moneyScale(connection.currency)
      : kind === 'campaign'
        ? entities
            .filter(
              (e) =>
                e.kind === 'adset' && e.parent_id === id && e.data.daily_budget
            )
            .reduce(
              (n, e) =>
                n +
                Number(e.data.daily_budget) / moneyScale(connection.currency),
              0
            ) || null
        : null;
    return {
      id: id || 'total',
      name: entity?.name || 'All campaigns',
      status: entity?.status || '',
      spend,
      impressions,
      clicks,
      messaging: series.reduce((n, i) => n + Number(i.messaging), 0),
      leads: leads.length,
      qualified: qualified.length,
      customers,
      revenue,
      cpl: leads.length ? spend / leads.length : null,
      cpql: qualified.length ? spend / qualified.length : null,
      cpa: customers ? spend / customers : null,
      roas: spend && !currencyMismatch ? revenue / spend : null,
      ctr: impressions ? clicks / impressions : null,
      dailyBudget: budget,
      budgetBaseline:
        budget == null
          ? null
          : budget *
            (Math.round((Date.parse(end) - Date.parse(start)) / 86400_000) + 1),
      currencyMismatch,
    };
  };
  const leads = input.contacts
    .filter((c) => leadSources.has(c.id))
    .map((c) => ({
      ...c,
      ad_id: leadSources.get(c.id)!,
      campaign_id: campaignForContact(c.id),
      qualification: latestQualifications.get(c.id) || null,
    }));
  const conversations = input.conversations.filter(
    (c) =>
      leadSources.has(c.contact_id) &&
      c.ads_first_customer_at &&
      inPeriod(day(c.ads_first_customer_at))
  );
  const responseMinutes = conversations
    .filter(
      (c) =>
        c.ads_first_human_at &&
        Date.parse(c.ads_first_human_at) >= Date.parse(c.ads_first_customer_at!)
    )
    .map(
      (c) =>
        (Date.parse(c.ads_first_human_at!) -
          Date.parse(c.ads_first_customer_at!)) /
        60_000
    )
    .sort((a, b) => a - b);
  const middle = Math.floor(responseMinutes.length / 2);
  const median = responseMinutes.length
    ? responseMinutes.length % 2
      ? responseMinutes[middle]
      : (responseMinutes[middle - 1] + responseMinutes[middle]) / 2
    : null;
  const daily = new Map<
    string,
    { date: string; spend: number; leads: number; qualified: number }
  >();
  const cursor = new Date(start + 'T00:00:00Z');
  while (cursor.toISOString().slice(0, 10) <= end) {
    const date = cursor.toISOString().slice(0, 10);
    daily.set(date, { date, spend: 0, leads: 0, qualified: 0 });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  for (const i of input.insights)
    if (daily.has(i.date)) daily.get(i.date)!.spend += Number(i.spend);
  for (const c of leads)
    if (daily.has(day(c.created_at))) daily.get(day(c.created_at))!.leads++;
  for (const q of latestQualifications.values())
    if (
      q.status === 'qualified' &&
      leadSources.has(q.contact_id) &&
      daily.has(day(q.occurred_at))
    )
      daily.get(day(q.occurred_at))!.qualified++;
  const journeys = (input.flows || []).filter(
    (f) => leadSources.has(f.contact_id) && inPeriod(day(f.started_at))
  );
  const flowMetrics = {
    started: journeys.length,
    completed: journeys.filter((f) => f.status === 'completed').length,
    timedOut: journeys.filter((f) => f.status === 'timed_out').length,
    handoffs: journeys.filter((f) =>
      ['handed_off', 'paused_by_agent'].includes(f.status)
    ).length,
    followUpAttempts: journeys.reduce(
      (n, f) => n + Number(f.follow_up_attempts || 0),
      0
    ),
    dropOffs: journeys
      .filter((f) => f.status === 'timed_out')
      .map((f) => ({
        flowId: f.flow_id,
        node: f.current_node_key,
        contactId: f.contact_id,
      })),
  };
  return {
    flowMetrics,
    summary: total(null),
    campaigns: campaigns.map((c) => total(c.meta_id)),
    adsets: entities
      .filter((e) => e.kind === 'adset')
      .map((e) => total(e.meta_id, 'adset')),
    ads: entities
      .filter((e) => e.kind === 'ad')
      .map((e) => total(e.meta_id, 'ad')),
    daily: [...daily.values()],
    leads,
    journey: {
      acquired: leads
        .filter((c) => inPeriod(day(c.created_at)))
        .map((c) => c.id),
      qualified: [...latestQualifications.values()]
        .filter(
          (q) =>
            q.status === 'qualified' &&
            leadSources.has(q.contact_id) &&
            inPeriod(day(q.occurred_at))
        )
        .map((q) => q.contact_id),
      customers: [
        ...new Set(
          input.sales
            .filter(
              (s) =>
                s.status === 'confirmed' &&
                leadSources.has(s.contact_id) &&
                inPeriod(day(s.occurred_at))
            )
            .map((s) => s.contact_id)
        ),
      ],
    },
    fallbackLeads,
    conversations: {
      total: conversations.length,
      engaged: conversations.filter(
        (c) => Number(c.ads_customer_messages || 0) >= 2
      ).length,
      engagedContactIds: conversations
        .filter((c) => Number(c.ads_customer_messages || 0) >= 2)
        .map((c) => c.contact_id),
      answeredContactIds: conversations
        .filter((c) => c.ads_first_human_at)
        .map((c) => c.contact_id),
      medianHumanMinutes: median,
      answeredByHuman: responseMinutes.length,
      botAssisted: conversations.filter((c) => c.ads_first_bot_at).length,
      unanswered: conversations.filter((c) => !c.ads_first_human_at).length,
      awaitingReply: conversations.filter(
        (c) =>
          c.last_message_sender_type === 'customer' && c.status !== 'closed'
      ).length,
    },
  };
}
export function campaignRecommendations(
  current: ReturnType<typeof campaignReport>,
  previous: ReturnType<typeof campaignReport>
) {
  const flags: {
    id: string;
    campaignId: string;
    title: string;
    evidence: string;
    action: string;
    category: string;
    sample: number;
  }[] = [];
  for (const c of current.campaigns) {
    const p = previous.campaigns.find((p) => p.id === c.id);
    if (c.spend > 0 && !c.leads)
      flags.push({
        id: `${c.id}:no-leads`,
        campaignId: c.id,
        title: 'Spend without CRM leads',
        evidence: `${c.spend.toFixed(2)} spent; ${c.clicks} clicks; 0 CRM leads in this period.`,
        action:
          'Review the ad destination and opening WhatsApp flow before increasing budget.',
        category: 'advertising',
        sample: c.clicks,
      });
    if (p?.cpql && c.cpql && c.cpql > p.cpql * 1.2)
      flags.push({
        id: `${c.id}:cpql`,
        campaignId: c.id,
        title: 'Qualified lead cost increased',
        evidence: `Cost per qualified lead changed from ${p.cpql.toFixed(2)} to ${c.cpql.toFixed(2)} (${c.qualified} qualified leads).`,
        action:
          'Compare creative and qualification reasons. Review a budget adjustment if the trend persists.',
        category: 'advertising',
        sample: c.qualified,
      });
    if (p?.ctr && c.ctr != null && c.ctr < p.ctr * 0.8)
      flags.push({
        id: `${c.id}:creative`,
        campaignId: c.id,
        title: 'Creative engagement declined',
        evidence: `CTR changed from ${(p.ctr * 100).toFixed(2)}% to ${(c.ctr * 100).toFixed(2)}% across ${c.impressions} impressions. This is a fatigue indicator, not proof.`,
        action:
          'Compare offers and creative variants; plan a controlled refresh.',
        category: 'creative',
        sample: c.impressions,
      });
    if (
      p?.leads &&
      c.leads &&
      c.qualified / c.leads < (p.qualified / p.leads) * 0.8
    )
      flags.push({
        id: `${c.id}:quality`,
        campaignId: c.id,
        title: 'Qualification declined',
        evidence: `${c.qualified} qualified outcomes / ${c.leads} new leads; compare lead cohorts before concluding a decline.`,
        action: 'Inspect qualification reasons and conversation drop-offs.',
        category: 'conversation',
        sample: c.leads,
      });
  }
  if (current.conversations.awaitingReply)
    flags.push({
      id: 'followup',
      campaignId: '',
      title: 'Conversations awaiting a reply',
      evidence: `${current.conversations.awaitingReply} open conversations have a customer as their last sender.`,
      action: 'Assign owners and review overdue follow-ups in the inbox.',
      category: 'sales',
      sample: current.conversations.total,
    });
  return flags;
}
