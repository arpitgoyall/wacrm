import { describe, it, expect } from 'vitest';
import {
  META_GRAPH_VERSION,
  normalizeAdAccountId,
  buildEdgeUrl,
  buildInsightsUrl,
  parseInsightsRow,
  rollingWindow,
} from './meta-sync';

describe('normalizeAdAccountId', () => {
  it('adds the act_ prefix when missing and trims', () => {
    expect(normalizeAdAccountId('123')).toBe('act_123');
    expect(normalizeAdAccountId('  act_123 ')).toBe('act_123');
  });
});

describe('buildEdgeUrl', () => {
  it('builds a pinned-version edge URL with fields + limit', () => {
    const url = buildEdgeUrl({
      adAccountId: '123',
      edge: 'campaigns',
      fields: ['name', 'status'],
    });
    expect(url).toContain(`/${META_GRAPH_VERSION}/act_123/campaigns?`);
    expect(url).toContain('fields=name%2Cstatus');
    expect(url).toContain('limit=200');
    expect(url).not.toContain('access_token');
  });

  it('adds the paging cursor when supplied', () => {
    expect(
      buildEdgeUrl({
        adAccountId: 'act_9',
        edge: 'ads',
        fields: ['name'],
        after: 'CURSOR==',
      })
    ).toContain('after=CURSOR%3D%3D');
  });
});

describe('buildInsightsUrl', () => {
  it('requests ad-level daily rows over the given window', () => {
    const url = buildInsightsUrl({
      adAccountId: '5',
      since: '2026-08-01',
      until: '2026-08-30',
    });
    expect(url).toContain('/act_5/insights?');
    expect(url).toContain('level=ad');
    expect(url).toContain('time_increment=1');
    expect(url).toContain(
      `time_range=${encodeURIComponent(
        JSON.stringify({ since: '2026-08-01', until: '2026-08-30' })
      )}`
    );
  });
});

describe('rollingWindow', () => {
  it('returns an inclusive N-day window ending today', () => {
    const w = rollingWindow(30, new Date('2026-09-07T12:00:00Z'));
    expect(w.until).toBe('2026-09-07');
    expect(w.since).toBe('2026-08-09'); // 30 days inclusive
  });
});

describe('parseInsightsRow', () => {
  it('flattens spend + link clicks + the largest messaging action', () => {
    const parsed = parseInsightsRow({
      ad_id: '999',
      date_start: '2026-08-15',
      date_stop: '2026-08-15',
      spend: '12.34',
      impressions: '1000',
      inline_link_clicks: '20',
      account_currency: 'INR',
      actions: [
        { action_type: 'link_click', value: '20' },
        {
          action_type: 'onsite_conversion.total_messaging_connection',
          value: '3',
        },
        {
          action_type: 'onsite_conversion.messaging_conversation_started_7d',
          value: '2',
        },
      ],
    });
    expect(parsed).toEqual({
      adId: '999',
      date: '2026-08-15',
      spend: 12.34,
      impressions: 1000,
      linkClicks: 20,
      messagingStarted: 3,
      currency: 'INR',
    });
  });

  it('returns null for a row with no ad_id / date', () => {
    expect(parseInsightsRow({ spend: '5' })).toBeNull();
  });

  it('defaults messaging to 0 when no messaging action is present', () => {
    const parsed = parseInsightsRow({
      ad_id: '1',
      date_start: '2026-08-15',
      spend: '5',
      actions: [{ action_type: 'link_click', value: '9' }],
    });
    expect(parsed?.messagingStarted).toBe(0);
  });
});
