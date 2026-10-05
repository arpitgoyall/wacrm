import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  rpc: vi.fn(),
  checkRateLimit: vi.fn(),
}));

vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  toErrorResponse: (error: { status?: number }) =>
    Response.json({ error: 'Forbidden' }, { status: error.status ?? 500 }),
}));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: mocks.checkRateLimit,
  RATE_LIMITS: { adminAction: {} },
  rateLimitResponse: () =>
    Response.json({ error: 'Rate limited' }, { status: 429 }),
}));

import { POST } from './route';

const sourceProfileId = '11111111-1111-4111-8111-111111111111';
const targetProfileId = '22222222-2222-4222-8222-222222222222';
const dealId = '33333333-3333-4333-8333-333333333333';
const body = { sourceProfileId, targetProfileId, dealIds: [dealId] };

function request(payload: unknown) {
  return new Request('http://localhost/api/deals/bulk-transfer', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireRole.mockResolvedValue({
    supabase: { rpc: mocks.rpc },
    accountId: 'account-1',
    userId: 'user-1',
    role: 'admin',
  });
  mocks.checkRateLimit.mockReturnValue({ success: true });
  mocks.rpc.mockResolvedValue({
    data: { dealsTransferred: 1, conversationsTransferred: 2 },
    error: null,
  });
});

describe('POST /api/deals/bulk-transfer', () => {
  it('requires admin and uses one atomic RPC with profile IDs', async () => {
    const response = await POST(request(body));
    expect(response.status).toBe(200);
    expect(mocks.requireRole).toHaveBeenCalledWith('admin');
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith('bulk_transfer_deals', {
      p_source_profile_id: sourceProfileId,
      p_target_profile_id: targetProfileId,
      p_deal_ids: [dealId],
    });
    expect(await response.json()).toEqual({
      ok: true,
      dealsTransferred: 1,
      conversationsTransferred: 2,
    });
  });

  it.each([401, 403])(
    'rejects unauthorized requests (%s) before writing',
    async (status) => {
      mocks.requireRole.mockRejectedValue({ status });
      const response = await POST(request(body));
      expect(response.status).toBe(status);
      expect(mocks.rpc).not.toHaveBeenCalled();
    }
  );

  it.each([
    null,
    {},
    { ...body, sourceProfileId: 'bad-id' },
    { ...body, targetProfileId: 1 },
    { ...body, targetProfileId: sourceProfileId },
    { ...body, dealIds: [] },
    { ...body, dealIds: 'not-an-array' },
    { ...body, dealIds: [null] },
    { ...body, dealIds: ['bad-id'] },
    { ...body, dealIds: [dealId, dealId] },
    { ...body, dealIds: Array.from({ length: 1001 }, () => dealId) },
  ])(
    'rejects malformed or unsafe selections without writing: %j',
    async (payload) => {
      const response = await POST(request(payload));
      expect(response.status).toBe(400);
      expect(mocks.rpc).not.toHaveBeenCalled();
    }
  );

  it('rejects invalid JSON', async () => {
    const response = await POST(
      new Request('http://localhost/api/deals/bulk-transfer', {
        method: 'POST',
        body: '{invalid',
      })
    );
    expect(response.status).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('treats UUID casing as the same agent or duplicate deal', async () => {
    const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    expect(
      (
        await POST(
          request({
            ...body,
            sourceProfileId: id,
            targetProfileId: id.toUpperCase(),
          })
        )
      ).status
    ).toBe(400);
    expect(
      (await POST(request({ ...body, dealIds: [id, id.toUpperCase()] }))).status
    ).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('bounds repeated transfers', async () => {
    mocks.checkRateLimit.mockReturnValue({ success: false });
    const response = await POST(request(body));
    expect(response.status).toBe(429);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it.each([
    ['42501', 403],
    ['22023', 400],
    ['40001', 409],
  ])('maps database rejection %s to %s', async (code, status) => {
    mocks.rpc.mockResolvedValue({
      data: null,
      error: { code, message: 'Rejected' },
    });
    const response = await POST(request(body));
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: 'Rejected' });
  });

  it('hides unexpected database error details', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.rpc.mockResolvedValue({
      data: null,
      error: { code: 'XX000', message: 'internal details' },
    });
    try {
      const response = await POST(request(body));
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({
        error: 'Failed to transfer leads',
      });
    } finally {
      log.mockRestore();
    }
  });
});
