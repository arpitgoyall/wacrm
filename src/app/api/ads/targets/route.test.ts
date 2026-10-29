import { describe, it, expect, vi, beforeEach } from 'vitest';
const mocks = vi.hoisted(() => ({
  role: vi.fn(),
  admin: vi.fn(),
  account: vi.fn(),
}));
vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.role,
  getCurrentAccount: mocks.account,
  toErrorResponse: () => Response.json({ error: 'Forbidden' }, { status: 403 }),
}));
vi.mock('@/lib/automations/admin-client', () => ({
  supabaseAdmin: mocks.admin,
}));
import { PUT, GET } from './route';
describe('workspace targets', () => {
  beforeEach(() => vi.resetAllMocks());
  it('rejects unauthorized writes before accessing storage', async () => {
    mocks.role.mockRejectedValue(Error('Forbidden'));
    expect(
      (await PUT(new Request('http://local', { method: 'PUT', body: '{}' })))
        .status
    ).toBe(403);
    expect(mocks.admin).not.toHaveBeenCalled();
  });
  it('validates positive numeric targets', async () => {
    mocks.role.mockResolvedValue({ accountId: 'workspace' });
    expect(
      (
        await PUT(
          new Request('http://local', {
            method: 'PUT',
            body: JSON.stringify({ max_cpl: -1, min_roas: 1 }),
          })
        )
      ).status
    ).toBe(400);
    expect(mocks.admin).not.toHaveBeenCalled();
  });
  it('writes targets only to the authenticated workspace', async () => {
    mocks.role.mockResolvedValue({ accountId: 'workspace' });
    const upsert = vi.fn().mockReturnValue({
      select: () => ({
        single: async () => ({
          data: { max_cpl: 5, min_roas: null },
          error: null,
        }),
      }),
    });
    mocks.admin.mockReturnValue({ from: () => ({ upsert }) });
    const result = await PUT(
      new Request('http://local', {
        method: 'PUT',
        body: JSON.stringify({
          account_id: 'other',
          max_cpl: 5,
          min_roas: null,
        }),
      })
    );
    expect(result.status).toBe(200);
    expect(upsert.mock.calls[0][0].account_id).toBe('workspace');
    expect(mocks.role).toHaveBeenCalledWith('admin');
  });
  it('allows members to read shared targets through the scoped client', async () => {
    mocks.account.mockResolvedValue({
      supabase: {
        from: () => ({
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: { max_cpl: 5, min_roas: 2 } }),
            }),
          }),
        }),
      },
    });
    expect(await (await GET()).json()).toEqual({
      targets: { max_cpl: 5, min_roas: 2 },
    });
  });
});
