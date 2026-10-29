/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ admin: vi.fn(), graph: vi.fn() }));
vi.mock('@/lib/automations/admin-client', () => ({
  supabaseAdmin: mocks.admin,
}));
vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: () => 'test-token' }));
vi.mock('./graph', () => ({ graph: mocks.graph }));
import { drainConversionEvents } from './outcomes';
function database(tables: Record<string, any[]>) {
  return {
    from: (table: string) => {
      const filters: ((r: any) => boolean)[] = [];
      let patch: any, insert: any;
      const result = () => {
        if (insert) {
          tables[table] ||= [];
          tables[table].push(insert);
          return { data: [insert], error: null };
        }
        const rows = (tables[table] || []).filter((r) =>
          filters.every((f) => f(r))
        );
        if (patch) rows.forEach((r) => Object.assign(r, patch));
        return { data: structuredClone(rows), error: null };
      };
      const q: any = {
        select: () => q,
        update: (v: any) => {
          patch = v;
          return q;
        },
        insert: (v: any) => {
          insert = v;
          return q;
        },
        eq: (key: string, value: any) => {
          filters.push((r) => r[key] === value);
          return q;
        },
        in: (key: string, value: any[]) => {
          filters.push((r) => value.includes(r[key]));
          return q;
        },
        lt: (key: string, value: any) => {
          filters.push((r) => r[key] != null && r[key] < value);
          return q;
        },
        lte: (key: string, value: any) => {
          filters.push((r) => r[key] <= value);
          return q;
        },
        order: () => q,
        limit: () => q,
        maybeSingle: async () => {
          const r = result();
          return { ...r, data: r.data[0] || null };
        },
        then: (resolve: any, reject: any) =>
          Promise.resolve(result()).then(resolve, reject),
      };
      return q;
    },
  };
}
function fixture(event: any = {}) {
  const tables: Record<string, any[]> = {
    ads_conversion_events: [
      {
        id: 'stable-event',
        account_id: 'workspace',
        outcome_key: 'qualified:contact',
        event_name: 'LeadSubmitted',
        ctwa_clid: 'click',
        occurred_at: '2026-10-01T12:00:00Z',
        status: 'pending',
        attempt_count: 0,
        next_attempt_at: '2026-10-01T12:00:00Z',
        ...event,
      },
    ],
    whatsapp_config: [
      {
        account_id: 'workspace',
        waba_id: 'waba',
        ctwa_dataset_id: 'dataset',
        ctwa_capi_token: 'encrypted',
      },
    ],
    ads_conversion_attempts: [],
    ads_sales: [],
  };
  mocks.admin.mockReturnValue(database(tables));
  return tables;
}
describe('durable conversion delivery', () => {
  beforeEach(() => vi.resetAllMocks());
  it('marks delivery only after Meta acknowledges the event and keeps a stable event identifier', async () => {
    const tables = fixture();
    mocks.graph.mockResolvedValue({ events_received: 1 });
    expect(await drainConversionEvents()).toEqual({ processed: 1 });
    expect(tables.ads_conversion_events[0].status).toBe('delivered');
    expect(mocks.graph.mock.calls[0][2].data[0].event_id).toBe('stable-event');
    await drainConversionEvents();
    expect(mocks.graph).toHaveBeenCalledTimes(1);
  });
  it('records an unacknowledged response as failed and retries with the same identity', async () => {
    const tables = fixture();
    mocks.graph.mockResolvedValue({});
    await drainConversionEvents();
    const event = tables.ads_conversion_events[0];
    expect(event.status).toBe('failed');
    expect(event.reason).toContain('did not confirm');
    event.next_attempt_at = '2026-10-01T12:00:00Z';
    mocks.graph.mockResolvedValue({ events_received: 1 });
    await drainConversionEvents();
    expect(event.attempt_count).toBe(2);
    expect(event.status).toBe('delivered');
    expect(mocks.graph.mock.calls[1][2].data[0].event_id).toBe('stable-event');
  });
  it('skips missing attribution without calling Meta', async () => {
    const tables = fixture({ ctwa_clid: null });
    await drainConversionEvents();
    expect(tables.ads_conversion_events[0].status).toBe('skipped');
    expect(mocks.graph).not.toHaveBeenCalled();
  });
  it('does not send an undelivered purchase after a sale is refunded', async () => {
    const tables = fixture({
      event_name: 'Purchase',
      outcome_key: 'sale:sale-id',
    });
    tables.ads_sales.push({
      id: 'sale-id',
      account_id: 'workspace',
      status: 'refunded',
    });
    await drainConversionEvents();
    expect(tables.ads_conversion_events[0].status).toBe('skipped');
    expect(mocks.graph).not.toHaveBeenCalled();
  });
});
