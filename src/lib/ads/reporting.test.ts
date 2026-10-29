import { describe, it, expect } from 'vitest';
import { buildPeriodReport, presetPeriod, performanceFlags } from './reporting';
import { aggregateAdPerformance } from './performance';

const period = { start: '2026-10-01', end: '2026-10-02', currency: 'USD' };
const contacts = [
  { id: 'c', ctwa_source_id: 'new-ad', created_at: '2026-10-01T00:00:00Z' },
];
const clicks = [
  {
    contact_id: 'c',
    ad_id: 'original-ad',
    occurred_at: '2026-10-01T00:00:01Z',
  },
  { contact_id: 'c', ad_id: 'new-ad', occurred_at: '2026-10-02T12:00:00Z' },
];
describe('period reporting', () => {
  it('flags waste, expensive leads and low returns with a maximum of five recommendations', () => {
    const { rows } = aggregateAdPerformance(
      [],
      [{ id: 'c', ctwa_source_id: 'costly', created_at: period.start }],
      [],
      [
        { ad_id: 'empty', spend: 10 },
        { ad_id: 'costly', spend: 100 },
      ]
    );
    const flags = performanceFlags(rows, { max_cpl: '5', min_roas: '2' });
    expect(flags.some((f) => f.includes('no CRM leads'))).toBe(true);
    expect(flags.some((f) => f.includes('CPL exceeds'))).toBe(true);
    expect(
      performanceFlags(rows, { max_cpl: '', min_roas: '2' }).some((f) =>
        f.includes('ROAS is below')
      )
    ).toBe(true);
    expect(
      performanceFlags([...rows, ...rows, ...rows], {
        max_cpl: '5',
        min_roas: '2',
      })
    ).toHaveLength(5);
  });
  it('uses inclusive dates, fills inactive days, and counts each acquired contact once', () => {
    const report = buildPeriodReport(
      contacts,
      [],
      [
        {
          ad_id: 'original-ad',
          date: '2026-09-30',
          spend: 99,
          currency: 'USD',
        },
        {
          ad_id: 'original-ad',
          date: '2026-10-02',
          spend: 10,
          currency: 'USD',
        },
      ],
      clicks,
      period
    );
    expect(report.daily).toEqual([
      { date: '2026-10-01', spend: 0, leads: 1 },
      { date: '2026-10-02', spend: 10, leads: 0 },
    ]);
    expect(report.contacts[0].ctwa_source_id).toBe('original-ad');
    expect(report.capturedLeads).toBe(1);
    expect(report.insights).toHaveLength(1);
  });
  it('does not treat a later first recorded tap as acquisition history', () => {
    const report = buildPeriodReport(contacts, [], [], clicks.slice(1), period);
    expect(report.fallbackLeads).toBe(1);
    expect(report.contacts[0].ctwa_source_id).toBe('new-ad');
  });
  it('keeps deals from older contacts in the period and preserves deal snapshots', () => {
    const report = buildPeriodReport(
      contacts,
      [
        {
          contact_id: 'c',
          ctwa_source_id: 'snapshot',
          value: 50,
          status: 'won',
          created_at: '2026-10-02T23:59:59Z',
        },
        {
          contact_id: 'c',
          ctwa_source_id: 'snapshot',
          value: 999,
          status: 'won',
          created_at: '2026-10-03T00:00:00Z',
        },
      ],
      [],
      clicks,
      { ...period, start: '2026-10-02' }
    );
    const result = aggregateAdPerformance([], report.contacts, report.deals);
    expect(result.summary.totalLeads).toBe(0);
    expect(result.summary.totalWon).toBe(1);
    expect(result.summary.totalRevenue).toBe(50);
    expect(result.rows[0].source_id).toBe('snapshot');
  });
  it('marks missing and mixed currencies incompatible', () => {
    expect(
      buildPeriodReport(
        [],
        [],
        [{ ad_id: 'a', date: period.start, spend: 1 }],
        [],
        period
      ).currencyCompatible
    ).toBe(false);
    const report = buildPeriodReport(
      [],
      [],
      [
        { ad_id: 'a', date: period.start, spend: 1, currency: 'USD' },
        { ad_id: 'b', date: period.start, spend: 1, currency: 'INR' },
      ],
      [],
      period
    );
    expect(report.currencyCompatible).toBe(false);
    expect(report.mixedCurrencies).toBe(true);
  });
  it('supports empty, all-time, and leap-year preset ranges', () => {
    expect(
      buildPeriodReport([], [], [], [], { ...period, start: '', end: '' }).daily
    ).toEqual([]);
    expect(presetPeriod(7, 'USD', new Date('2024-03-01T12:00:00Z')).start).toBe(
      '2024-02-24'
    );
  });
});
