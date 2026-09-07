import { describe, it, expect, vi } from 'vitest';
import { resolveAdBinding } from './bindings';

/**
 * Minimal PostgREST-ish fake: `.from(table).select().eq()..maybeSingle()`.
 * `handlers[table]` gets the accumulated `eq` filters and returns the
 * row (or null), or throws to simulate an error.
 */
function fakeDb(
  handlers: Record<string, (f: Record<string, unknown>) => unknown>
) {
  return {
    from(table: string) {
      const filters: Record<string, unknown> = {};
      const builder = {
        select: () => builder,
        eq: (col: string, val: unknown) => {
          filters[col] = val;
          return builder;
        },
        maybeSingle: async () => ({
          data: handlers[table] ? handlers[table](filters) : null,
          error: null,
        }),
      };
      return builder;
    },
  };
}

describe('resolveAdBinding', () => {
  it('returns the ad-level flow binding and never looks at the campaign', async () => {
    const adsSpy = vi.fn();
    const db = fakeDb({
      ctwa_ad_bindings: (f) =>
        f.match_type === 'ad' && f.match_value === 'ad_1'
          ? { flow_id: 'flow_ad', automation_id: null }
          : null,
      ctwa_ads: (f) => {
        adsSpy(f);
        return { campaign_id: 'camp_1' };
      },
    });
    expect(await resolveAdBinding(db, 'acct', 'ad_1')).toEqual({
      flow_id: 'flow_ad',
      automation_id: null,
    });
    expect(adsSpy).not.toHaveBeenCalled();
  });

  it('returns an ad-level automation binding', async () => {
    const db = fakeDb({
      ctwa_ad_bindings: (f) =>
        f.match_type === 'ad'
          ? { flow_id: null, automation_id: 'auto_7' }
          : null,
    });
    expect(await resolveAdBinding(db, 'acct', 'ad_x')).toEqual({
      flow_id: null,
      automation_id: 'auto_7',
    });
  });

  it("falls back to a campaign-level binding via the ad's campaign_id", async () => {
    const db = fakeDb({
      ctwa_ad_bindings: (f) =>
        f.match_type === 'campaign' && f.match_value === 'camp_1'
          ? { flow_id: 'flow_camp', automation_id: null }
          : null,
      ctwa_ads: () => ({ campaign_id: 'camp_1' }),
    });
    expect(await resolveAdBinding(db, 'acct', 'ad_2')).toEqual({
      flow_id: 'flow_camp',
      automation_id: null,
    });
  });

  it('returns null when the ad has no campaign and no ad binding', async () => {
    const db = fakeDb({
      ctwa_ad_bindings: () => null,
      ctwa_ads: () => ({ campaign_id: null }),
    });
    expect(await resolveAdBinding(db, 'acct', 'ad_3')).toBeNull();
  });

  it('returns null when a campaign id exists but nothing is bound to it', async () => {
    const db = fakeDb({
      ctwa_ad_bindings: () => null,
      ctwa_ads: () => ({ campaign_id: 'camp_9' }),
    });
    expect(await resolveAdBinding(db, 'acct', 'ad_4')).toBeNull();
  });

  it('swallows a query error and returns null', async () => {
    const db = fakeDb({
      ctwa_ad_bindings: () => {
        throw new Error('boom');
      },
    });
    expect(await resolveAdBinding(db, 'acct', 'ad_5')).toBeNull();
  });
});
