/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';
const mocks = vi.hoisted(() => ({
  admin: vi.fn(),
  token: vi.fn(),
  graph: vi.fn(),
  pages: vi.fn(),
}));
vi.mock('@/lib/automations/admin-client', () => ({
  supabaseAdmin: mocks.admin,
}));
vi.mock('./workspace', () => ({ connectionToken: mocks.token }));
vi.mock('./graph', () => ({
  graph: mocks.graph,
  graphPages: mocks.pages,
  GraphError: class extends Error {
    transient = true;
  },
}));
import {
  applyCampaignChange,
  prepareCampaignChange,
  validateDraft,
  type CampaignDraft,
} from './campaign-actions';
import { GraphError } from './graph';
function memoryDb(tables: Record<string, any[]>) {
  return {
    from: (table: string) => {
      const filters: ((r: any) => boolean)[] = [];
      let update: any;
      const result = () => {
        const found = (tables[table] || []).filter((r) =>
          filters.every((f) => f(r))
        );
        if (update) found.forEach((r) => Object.assign(r, update));
        return { data: found, error: null };
      };
      const q: any = {
        update: (v: any) => {
          update = v;
          return q;
        },
        eq: (k: string, v: any) => {
          filters.push((r) => r[k] === v);
          return q;
        },
        in: (k: string, v: any[]) => {
          filters.push((r) => v.includes(r[k]));
          return q;
        },
        select: () => q,
        maybeSingle: async () => {
          const r = result();
          return { ...r, data: r.data[0] || null };
        },
        single: async () => {
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
const draft: CampaignDraft = {
  connectionId: 'connection',
  name: 'Launch',
  goal: 'qualified',
  pageId: '123',
  whatsapp: '919876543210',
  country: 'IN',
  ageMin: 18,
  ageMax: 65,
  dailyBudget: 10,
  start: '2029-01-01T00:00:00Z',
  end: '2029-02-01T00:00:00Z',
  headline: 'Offer',
  message: 'Details',
  openingMessage: 'Hello',
  imageUrl: 'https://example.com/product.png',
  launch: false,
};
beforeEach(() => {
  vi.resetAllMocks();
  mocks.token.mockResolvedValue({
    connection: {
      id: 'connection',
      meta_account_id: 'act_1',
      currency: 'USD',
      permissions: ['ads_management'],
    },
    token: 'token',
  });
});
describe('reviewed campaign changes', () => {
  it('requires management permission before preparing any change', async () => {
    mocks.token.mockResolvedValue({
      connection: { permissions: [] },
      token: 'token',
    });
    await expect(
      prepareCampaignChange('workspace', 'admin', {
        connectionId: 'connection',
        action: 'status',
      })
    ).rejects.toThrow('permission');
    expect(mocks.graph).not.toHaveBeenCalled();
  });
  it('blocks a stale budget review before any Meta write', async () => {
    const change = {
      id: 'r',
      account_id: 'workspace',
      connection_id: 'connection',
      status: 'review',
      action: 'budget',
      entity_id: 'entity',
      before_data: { daily_budget: '100' },
      after_data: { daily_budget: 200 },
      remote_ids: {},
    };
    mocks.admin.mockReturnValue(memoryDb({ ads_change_requests: [change] }));
    mocks.graph.mockResolvedValue({ account_id: '1', daily_budget: '300' });
    await expect(
      applyCampaignChange('workspace', 'r', 'admin')
    ).rejects.toThrow('changed since review');
    expect(change.status).toBe('failed');
    expect(mocks.graph.mock.calls.every((c) => c[3] !== 'POST')).toBe(true);
  });
  it('applies a claimed change once and rejects a duplicate approval', async () => {
    const change = {
      id: 'r',
      account_id: 'workspace',
      connection_id: 'connection',
      status: 'review',
      action: 'status',
      entity_id: 'entity',
      before_data: { status: 'ACTIVE' },
      after_data: { status: 'PAUSED' },
      remote_ids: {},
    };
    mocks.admin.mockReturnValue(memoryDb({ ads_change_requests: [change] }));
    mocks.graph.mockResolvedValue({ account_id: '1', status: 'ACTIVE' });
    await applyCampaignChange('workspace', 'r', 'admin');
    expect(change.status).toBe('applied');
    await expect(
      applyCampaignChange('workspace', 'r', 'admin')
    ).rejects.toThrow('already processing');
    expect(mocks.graph.mock.calls.filter((c) => c[3] === 'POST')).toHaveLength(
      1
    );
  });
  it('retains created IDs and marks an ambiguous publish uncertain', async () => {
    const change = {
      id: 'r',
      account_id: 'workspace',
      connection_id: 'connection',
      status: 'review',
      action: 'publish',
      entity_id: 'draft',
      after_data: { draft },
      remote_ids: {},
    };
    mocks.admin.mockReturnValue(memoryDb({ ads_change_requests: [change] }));
    mocks.graph
      .mockResolvedValueOnce({ id: 'campaign' })
      .mockRejectedValueOnce(
        new GraphError('Network outcome uncertain', 500, true)
      );
    await expect(
      applyCampaignChange('workspace', 'r', 'admin')
    ).rejects.toThrow('uncertain');
    expect(change.status).toBe('uncertain');
    expect((change.remote_ids as any).campaign).toBe('campaign');
    expect((change.remote_ids as any).inflight).toBe('adset');
    expect(mocks.graph.mock.calls.some((c) => c[2]?.status === 'ACTIVE')).toBe(
      false
    );
  });
  it('creates paused resources unless activation was explicitly reviewed', async () => {
    const change = {
      id: 'r',
      account_id: 'workspace',
      connection_id: 'connection',
      status: 'review',
      action: 'publish',
      entity_id: 'draft',
      after_data: { draft },
      remote_ids: {},
    };
    mocks.admin.mockReturnValue(memoryDb({ ads_change_requests: [change] }));
    mocks.graph.mockImplementation(
      async (path: string, _token: string, params: any, method: string) =>
        path.endsWith('/adimages')
          ? { images: { image: { hash: 'hash' } } }
          : method === 'POST'
            ? { id: path.split('/').at(-1) }
            : { status: 'PAUSED' }
    );
    await applyCampaignChange('workspace', 'r', 'admin');
    expect(change.status).toBe('applied');
    expect(
      mocks.graph.mock.calls.filter((c) => c[2]?.status === 'PAUSED')
    ).toHaveLength(3);
    expect(mocks.graph.mock.calls.some((c) => c[2]?.status === 'ACTIVE')).toBe(
      false
    );
  });
  it('rejects malformed and regulated-category drafts', () => {
    expect(() => validateDraft({ ...draft, dailyBudget: -1 })).toThrow();
    expect(() =>
      validateDraft({ ...draft, specialCategories: ['HOUSING'] })
    ).toThrow('Regulated');
    expect(() => validateDraft(draft)).not.toThrow();
  });
});
