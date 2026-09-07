import { describe, it, expect } from 'vitest';
import {
  aggregateAdPerformance,
  type AdRegistryRow,
  type AdContactRow,
  type AdDealRow,
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
    // close rate is won / leads, not won / deals
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

  it('falls back to the contact source_id for a hand-created deal with no snapshot', () => {
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

  it('keeps an ad that only appears in deal/contact data but has no registry row', () => {
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
    });
  });

  it('sorts by leads desc, then revenue, then source_id', () => {
    const { rows } = aggregateAdPerformance(
      [ad({ source_id: 'A' }), ad({ source_id: 'B' }), ad({ source_id: 'C' })],
      [
        contact('c1', 'B'),
        contact('c2', 'B'),
        contact('c3', 'A'),
        contact('c4', 'C'),
      ],
      [
        deal({
          contact_id: 'c4',
          ctwa_source_id: 'C',
          status: 'won',
          value: 5000,
        }),
      ]
    );
    expect(rows.map((r) => r.source_id)).toEqual(['B', 'C', 'A']);
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
});
