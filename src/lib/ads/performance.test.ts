import { describe, it, expect } from 'vitest';
import {
  aggregateAdPerformance,
  groupAdPerformance,
  type AdRegistryRow,
  type AdContactRow,
  type AdDealRow,
  type AdInsightRow,
} from './performance';

const ad = (
  over: Partial<AdRegistryRow> & { source_id: string }
): AdRegistryRow => ({
  id: `reg-${over.source_id}`,
  label: null,
  headline: null,
  body: null,
  source_url: null,
  source_type: null,
  first_seen_at: '2026-01-01T00:00:00Z',
  last_seen_at: '2026-01-05T00:00:00Z',
  campaign_id: null,
  adset_id: null,
  meta_name: null,
  effective_status: null,
  ...over,
});

const contact = (id: string, ctwa_source_id: string | null): AdContactRow => ({
  id,
  ctwa_source_id,
  created_at: '2026-01-02T00:00:00Z',
});

const deal = (over: Partial<AdDealRow>): AdDealRow => ({
  contact_id: null,
  ctwa_source_id: null,
  value: 0,
  status: 'open',
  created_at: '2026-01-03T00:00:00Z',
  ...over,
});

const insight = (
  ad_id: string,
  spend: number,
  currency = 'USD'
): AdInsightRow => ({ ad_id, spend, currency });

describe('aggregateAdPerformance', () => {
  it('counts leads per ad from the contact ctwa_source_id', () => {
    const { rows } = aggregateAdPerformance(
      [ad({ source_id: 'A' }), ad({ source_id: 'B' })],
      [contact('c1', 'A'), contact('c2', 'A'), contact('c3', 'B')],
      []
    );
    expect(rows.find((r) => r.source_id === 'A')?.leads).toBe(2);
    expect(rows.find((r) => r.source_id === 'B')?.leads).toBe(1);
  });

  it('attributes a deal to its own snapshot, and won revenue over leads', () => {
    const { rows, summary } = aggregateAdPerformance(
      [ad({ source_id: 'A' })],
      [
        contact('c1', 'A'),
        contact('c2', 'A'),
        contact('c3', 'A'),
        contact('c4', 'A'),
      ],
      [
        deal({
          contact_id: 'c1',
          ctwa_source_id: 'A',
          status: 'won',
          value: 1000,
        }),
        deal({
          contact_id: 'c2',
          ctwa_source_id: 'A',
          status: 'won',
          value: '500',
        }),
        deal({
          contact_id: 'c3',
          ctwa_source_id: 'A',
          status: 'lost',
          value: 999,
        }),
        deal({
          contact_id: 'c4',
          ctwa_source_id: 'A',
          status: 'open',
          value: 200,
        }),
      ]
    );
    const a = rows[0];
    expect(a).toMatchObject({
      leads: 4,
      deals: 4,
      won: 2,
      lost: 1,
      open: 1,
      revenue: 1500,
    });
    expect(a.closeRate).toBe(0.5);
    expect(a.revenuePerLead).toBe(375);
    expect(summary).toMatchObject({
      adCount: 1,
      totalLeads: 4,
      totalWon: 2,
      totalRevenue: 1500,
      blendedCloseRate: 0.5,
    });
  });

  it('falls back to the contact source_id for a hand-created deal', () => {
    const { rows } = aggregateAdPerformance(
      [ad({ source_id: 'A' })],
      [contact('c1', 'A')],
      [
        deal({
          contact_id: 'c1',
          ctwa_source_id: null,
          status: 'won',
          value: 750,
        }),
      ]
    );
    expect(rows[0]).toMatchObject({ source_id: 'A', won: 1, revenue: 750 });
  });

  it('treats a null status as an open deal', () => {
    const { rows } = aggregateAdPerformance(
      [ad({ source_id: 'A' })],
      [contact('c1', 'A')],
      [
        deal({
          contact_id: 'c1',
          ctwa_source_id: 'A',
          status: null,
          value: 100,
        }),
      ]
    );
    expect(rows[0]).toMatchObject({ deals: 1, open: 1, won: 0, revenue: 0 });
  });

  it('ignores deals that resolve to no ad', () => {
    const { rows, summary } = aggregateAdPerformance(
      [ad({ source_id: 'A' })],
      [contact('c1', 'A')],
      [
        deal({
          contact_id: 'c2',
          ctwa_source_id: null,
          status: 'won',
          value: 9999,
        }),
        deal({
          contact_id: null,
          ctwa_source_id: null,
          status: 'won',
          value: 9999,
        }),
      ]
    );
    expect(rows[0].deals).toBe(0);
    expect(summary.totalRevenue).toBe(0);
  });

  it('keeps an ad that only appears in data with no registry row', () => {
    const { rows } = aggregateAdPerformance(
      [],
      [contact('c1', 'ORPHAN')],
      [
        deal({
          contact_id: 'c1',
          ctwa_source_id: 'ORPHAN',
          status: 'won',
          value: 10,
        }),
      ]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: null,
      source_id: 'ORPHAN',
      leads: 1,
      won: 1,
    });
  });

  it('includes a registry ad with zero traffic', () => {
    const { rows } = aggregateAdPerformance([ad({ source_id: 'NEW' })], [], []);
    expect(rows[0]).toMatchObject({
      source_id: 'NEW',
      leads: 0,
      deals: 0,
      closeRate: 0,
      revenuePerLead: 0,
      roas: null,
      cpl: null,
    });
  });

  it('carries registry label / headline / source_url onto the row', () => {
    const { rows } = aggregateAdPerformance(
      [
        ad({
          source_id: 'A',
          label: 'Launch reel',
          headline: '50% off',
          source_url: 'https://fb.com/ad/A',
        }),
      ],
      [contact('c1', 'A')],
      []
    );
    expect(rows[0]).toMatchObject({
      label: 'Launch reel',
      headline: '50% off',
      source_url: 'https://fb.com/ad/A',
    });
  });

  // --- Phase 2: spend / ROAS / CPL ------------------------------------

  it('computes spend, ROAS and CPL from insights', () => {
    const { rows, summary } = aggregateAdPerformance(
      [ad({ source_id: 'A' })],
      [contact('c1', 'A'), contact('c2', 'A')],
      [
        deal({
          contact_id: 'c1',
          ctwa_source_id: 'A',
          status: 'won',
          value: 400,
        }),
      ],
      [insight('A', 60), insight('A', 40)]
    );
    expect(rows[0]).toMatchObject({
      spend: 100,
      currency: 'USD',
      roas: 4,
      cpl: 50,
      cpd: 100,
    });
    expect(summary).toMatchObject({
      totalSpend: 100,
      blendedRoas: 4,
      blendedCpl: 50,
    });
  });

  it('leaves ROAS/CPL null when there is no spend', () => {
    const { rows, summary } = aggregateAdPerformance(
      [ad({ source_id: 'A' })],
      [contact('c1', 'A')],
      [
        deal({
          contact_id: 'c1',
          ctwa_source_id: 'A',
          status: 'won',
          value: 400,
        }),
      ]
    );
    expect(rows[0].roas).toBeNull();
    expect(rows[0].cpl).toBeNull();
    expect(summary.blendedRoas).toBeNull();
  });

  it('surfaces a spend-only ad (insights but no leads yet)', () => {
    const { rows } = aggregateAdPerformance(
      [ad({ source_id: 'A' })],
      [],
      [],
      [insight('A', 25)]
    );
    // spend but no revenue -> ROAS 0 (real: burned money, no return);
    // CPL null because there are no leads to divide by.
    expect(rows[0]).toMatchObject({ spend: 25, leads: 0, roas: 0, cpl: null });
  });

  it('resolves campaign / ad-set names from the meta tables', () => {
    const { rows } = aggregateAdPerformance(
      [ad({ source_id: 'A', campaign_id: 'camp1', adset_id: 'set1' })],
      [contact('c1', 'A')],
      [],
      [],
      [{ campaign_id: 'camp1', name: 'Spring push' }],
      [{ adset_id: 'set1', name: 'Lookalike 1%' }]
    );
    expect(rows[0]).toMatchObject({
      campaignName: 'Spring push',
      adsetName: 'Lookalike 1%',
    });
  });
});

describe('groupAdPerformance', () => {
  const rows = aggregateAdPerformance(
    [
      ad({ source_id: 'A', campaign_id: 'camp1', adset_id: 'set1' }),
      ad({ source_id: 'B', campaign_id: 'camp1', adset_id: 'set2' }),
      ad({ source_id: 'C', campaign_id: null, adset_id: null }),
    ],
    [
      contact('c1', 'A'),
      contact('c2', 'A'),
      contact('c3', 'B'),
      contact('c4', 'C'),
    ],
    [
      deal({
        contact_id: 'c1',
        ctwa_source_id: 'A',
        status: 'won',
        value: 300,
      }),
      deal({
        contact_id: 'c3',
        ctwa_source_id: 'B',
        status: 'won',
        value: 700,
      }),
    ],
    [insight('A', 100), insight('B', 100), insight('C', 50)]
  ).rows;

  it('passes rows through at ad level', () => {
    const g = groupAdPerformance(rows, 'ad');
    expect(g).toHaveLength(3);
    expect(g.every((r) => r.ads === 1)).toBe(true);
  });

  it('rolls up by campaign, bucketing unassigned ads', () => {
    const g = groupAdPerformance(rows, 'campaign');
    const camp1 = g.find((r) => r.name === 'camp1');
    expect(camp1).toMatchObject({
      ads: 2,
      leads: 3,
      won: 2,
      revenue: 1000,
      spend: 200,
      roas: 5,
    });
    expect(g.find((r) => r.key === '__unassigned__')).toMatchObject({
      ads: 1,
      leads: 1,
    });
  });

  it('rolls up by ad set', () => {
    const g = groupAdPerformance(rows, 'adset');
    expect(g.find((r) => r.key === 'set1')).toMatchObject({
      leads: 2,
      spend: 100,
    });
    expect(g.find((r) => r.key === 'set2')).toMatchObject({ leads: 1, won: 1 });
  });
});
