import { describe, it, expect } from 'vitest';
import {
  campaignReport,
  previousPeriod,
  moneyScale,
  dayInZone,
  campaignRecommendations,
} from './workspace-report';
import type { AdConnection, CampaignEntity } from './workspace';
const connection: AdConnection = {
  id: 'one',
  account_id: 'business',
  meta_account_id: 'act_1',
  name: 'One',
  currency: 'USD',
  timezone: 'America/New_York',
  permissions: [],
  status: 'connected',
  error: null,
  synced_at: null,
  history_start: null,
  backfill_until: null,
  sync_claimed_at: null,
};
const entity = (
  kind: CampaignEntity['kind'],
  id: string,
  parent: string | null
): CampaignEntity => ({
  id,
  meta_id: id,
  connection_id: 'one',
  kind,
  parent_id: parent,
  name: id,
  status: 'ACTIVE',
  data: {},
});
const input = {
  connection,
  entities: [
    entity('campaign', 'campaign', null),
    entity('adset', 'set', 'campaign'),
    entity('ad', 'ad', 'set'),
  ],
  insights: [
    {
      connection_id: 'one',
      ad_id: 'ad',
      date: '2026-10-01',
      spend: 20,
      impressions: 1000,
      clicks: 10,
      messaging: 3,
    },
  ],
  contacts: [
    {
      id: 'lead',
      name: 'Lead',
      ctwa_source_id: 'ad',
      created_at: '2026-10-02T01:00:00Z',
    },
  ],
  clicks: [],
  qualifications: [],
  sales: [],
  conversations: [],
  start: '2026-10-01',
  end: '2026-10-01',
};
describe('campaign workspace reporting', () => {
  it('uses the ad-account timezone for CRM timestamps and rolls up all three levels', () => {
    const r = campaignReport(input);
    expect(r.summary.leads).toBe(1);
    expect(r.campaigns[0].spend).toBe(20);
    expect(r.adsets[0].leads).toBe(1);
    expect(r.ads[0].leads).toBe(1);
    expect(r.daily[0].leads).toBe(1);
  });
  it('keeps zero-lead campaigns visible and highlights their spend', () => {
    const r = campaignReport({ ...input, contacts: [] });
    expect(r.campaigns).toHaveLength(1);
    expect(
      campaignRecommendations(
        r,
        campaignReport({ ...input, insights: [], contacts: [] })
      )[0].id
    ).toBe('campaign:no-leads');
  });
  it('preserves acquisition source after a later ad tap and excludes future qualification changes', () => {
    const r = campaignReport({
      ...input,
      contacts: [{ ...input.contacts[0], ctwa_source_id: 'other' }],
      clicks: [
        {
          contact_id: 'lead',
          ad_id: 'ad',
          occurred_at: '2026-10-02T01:00:01Z',
        },
        {
          contact_id: 'lead',
          ad_id: 'other',
          occurred_at: '2026-10-03T01:00:00Z',
        },
      ],
      qualifications: [
        {
          id: 'q1',
          contact_id: 'lead',
          status: 'qualified',
          source: 'staff',
          reason: 'Booked',
          occurred_at: '2026-10-02T02:00:00Z',
        },
        {
          id: 'q2',
          contact_id: 'lead',
          status: 'unqualified',
          source: 'staff',
          reason: 'Later',
          occurred_at: '2026-10-03T12:00:00Z',
        },
      ],
    });
    expect(r.summary.qualified).toBe(1);
    expect(r.fallbackLeads).toBe(0);
  });
  it('does not combine sale currencies or invent valid ROAS for mixed currencies', () => {
    const r = campaignReport({
      ...input,
      sales: [
        {
          id: 's',
          contact_id: 'lead',
          deal_id: 'd',
          value: 100,
          currency: 'INR',
          source: 'payment',
          status: 'confirmed',
          occurred_at: '2026-10-02T02:00:00Z',
        },
      ],
    });
    expect(r.summary.revenue).toBe(0);
    expect(r.summary.currencyMismatch).toBe(true);
    expect(r.summary.roas).toBeNull();
  });
  it('separates human response from bot messages and measures timed-out flows', () => {
    const r = campaignReport({
      ...input,
      conversations: [
        {
          contact_id: 'lead',
          ads_first_customer_at: '2026-10-01T12:00:00Z',
          ads_first_human_at: '2026-10-01T12:05:00Z',
          ads_first_bot_at: '2026-10-01T12:00:01Z',
          last_message_sender_type: 'customer',
          status: 'open',
        },
      ],
      flows: [
        {
          id: 'f',
          contact_id: 'lead',
          flow_id: 'flow',
          status: 'timed_out',
          current_node_key: 'budget',
          started_at: '2026-10-01T12:00:00Z',
          ended_at: null,
          follow_up_attempts: 1,
        },
      ],
    });
    expect(r.conversations.medianHumanMinutes).toBe(5);
    expect(r.conversations.awaitingReply).toBe(1);
    expect(r.flowMetrics.dropOffs[0].node).toBe('budget');
  });
  it('handles leap dates, currency scales and invalid ranges', () => {
    expect(previousPeriod('2024-03-01', '2024-03-01')).toEqual({
      start: '2024-02-29',
      end: '2024-02-29',
    });
    expect(moneyScale('JPY')).toBe(1);
    expect(moneyScale('USD')).toBe(100);
    expect(dayInZone('2026-10-02T01:00:00Z', 'America/New_York')).toBe(
      '2026-10-01'
    );
    expect(() => previousPeriod('2026-10-03', '2026-10-01')).toThrow();
  });
});
