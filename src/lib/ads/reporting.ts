import type { AdContactRow, AdDealRow, AdInsightRow } from './performance';

export interface ReportPeriod {
  start: string;
  end: string;
  currency: string;
}
export interface ClickEvent {
  contact_id: string | null;
  ad_id: string | null;
  occurred_at: string;
}

// Reporting dates use UTC consistently with date-only insight rows.
export function inPeriod(date: string, period: ReportPeriod) {
  const day = date.slice(0, 10);
  return (
    (!period.start || day >= period.start) && (!period.end || day <= period.end)
  );
}
export function presetPeriod(
  days: number,
  currency: string,
  now = new Date()
): ReportPeriod {
  const end = now.toISOString().slice(0, 10);
  const start = new Date(end + 'T00:00:00Z');
  start.setUTCDate(start.getUTCDate() - days + 1);
  return { start: start.toISOString().slice(0, 10), end, currency };
}

export function buildPeriodReport(
  contacts: AdContactRow[],
  deals: AdDealRow[],
  insights: AdInsightRow[],
  clicks: ClickEvent[],
  period: ReportPeriod,
  readError = false
) {
  const firstClicks = new Map<string, ClickEvent>();
  for (const click of clicks) {
    if (!click.contact_id || !click.ad_id) continue;
    const previous = firstClicks.get(click.contact_id);
    if (!previous || click.occurred_at < previous.occurred_at)
      firstClicks.set(click.contact_id, click);
  }
  let fallbackLeads = 0;
  const attributed = contacts.map((contact) => {
    const click = firstClicks.get(contact.id);
    // A returning contact's first recorded click cannot establish their acquisition source.
    const captured =
      click &&
      Date.parse(click.occurred_at) <=
        Date.parse(contact.created_at) + 5 * 60_000;
    if (
      !captured &&
      contact.ctwa_source_id &&
      inPeriod(contact.created_at, period)
    )
      fallbackLeads++;
    return {
      ...contact,
      ctwa_source_id: captured ? click.ad_id : contact.ctwa_source_id,
    };
  });
  const sourceByContact = new Map(
    attributed.map((c) => [c.id, c.ctwa_source_id])
  );
  const selectedContacts = attributed.filter(
    (c) => c.ctwa_source_id && inPeriod(c.created_at, period)
  );
  const selectedDeals = deals
    .filter((d) => inPeriod(d.created_at, period))
    .map((d) => {
      const history = clicks
        .filter(
          (c) =>
            c.contact_id === d.contact_id &&
            c.ad_id &&
            c.occurred_at <= d.created_at
        )
        .sort((a, b) => b.occurred_at.localeCompare(a.occurred_at));
      return {
        ...d,
        ctwa_source_id:
          d.ctwa_source_id ??
          history[0]?.ad_id ??
          (d.contact_id ? (sourceByContact.get(d.contact_id) ?? null) : null),
      };
    });
  const selectedInsights = insights.filter(
    (i) => i.date && inPeriod(i.date, period)
  );
  const currencies = [
    ...new Set(
      selectedInsights
        .map((i) => i.currency)
        .filter((c): c is string => Boolean(c))
    ),
  ];
  const currencyCompatible =
    currencies.length === 1 &&
    currencies[0] === period.currency &&
    selectedInsights.every((i) => i.currency === period.currency);
  const spendCurrency =
    currencies.length === 1 &&
    selectedInsights.every((i) => i.currency === currencies[0])
      ? currencies[0]
      : null;
  const daily = new Map<
    string,
    { date: string; spend: number; leads: number }
  >();
  const point = (date: string) => {
    if (!daily.has(date)) daily.set(date, { date, spend: 0, leads: 0 });
    return daily.get(date)!;
  };
  for (const i of selectedInsights)
    point(i.date!).spend += Number(i.spend) || 0;
  for (const c of selectedContacts) point(c.created_at.slice(0, 10)).leads++;
  const dates = [...daily.keys()].sort();
  const start = period.start || dates[0];
  const end = period.end || dates.at(-1);
  if (start && end) {
    const cursor = new Date(start + 'T00:00:00Z');
    for (
      let count = 0;
      cursor.toISOString().slice(0, 10) <= end && count < 3660;
      count++
    ) {
      point(cursor.toISOString().slice(0, 10));
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
  }
  return {
    contacts: selectedContacts,
    deals: selectedDeals,
    insights: selectedInsights,
    daily: [...daily.values()].sort((a, b) => a.date.localeCompare(b.date)),
    fallbackLeads: Math.min(fallbackLeads, selectedContacts.length),
    capturedLeads:
      selectedContacts.length -
      Math.min(fallbackLeads, selectedContacts.length),
    readError,
    currencyCompatible,
    spendCurrency,
    mixedCurrencies: currencies.length > 1,
    insightStart:
      insights
        .map((i) => i.date)
        .filter(Boolean)
        .sort()[0] ?? null,
    impressions: selectedInsights.reduce(
      (s, i) => s + Number(i.impressions || 0),
      0
    ),
    clicks: selectedInsights.reduce(
      (s, i) => s + Number(i.link_clicks || 0),
      0
    ),
    messaging: selectedInsights.reduce(
      (s, i) => s + Number(i.messaging_started || 0),
      0
    ),
  };
}

export function performanceFlags(
  rows: import('./performance').AdPerformanceRow[],
  targets: { max_cpl: string; min_roas: string }
) {
  return rows
    .flatMap((row) => {
      const name = row.label || row.metaName || row.source_id;
      if (row.spend > 0 && row.leads === 0)
        return [
          `${name}: spend recorded with no CRM leads. Review targeting and the WhatsApp entry flow.`,
        ];
      if (
        Number(targets.max_cpl) > 0 &&
        row.cpl != null &&
        row.cpl > Number(targets.max_cpl)
      )
        return [
          `${name}: CPL exceeds the workspace target. Review lead quality and creative before increasing spend.`,
        ];
      if (
        Number(targets.min_roas) > 0 &&
        row.roas != null &&
        row.roas < Number(targets.min_roas)
      )
        return [
          `${name}: ROAS is below the workspace target. Check sales follow-up and allow time for open deals to close.`,
        ];
      return [];
    })
    .slice(0, 5);
}
