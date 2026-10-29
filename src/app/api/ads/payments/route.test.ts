import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
const mocks = vi.hoisted(() => ({ admin: vi.fn(), confirm: vi.fn() }));
vi.mock('@/lib/automations/admin-client', () => ({
  supabaseAdmin: mocks.admin,
}));
vi.mock('@/lib/ads/sale-confirmation', () => ({ confirmSale: mocks.confirm }));
import { POST } from './route';
describe('external sale confirmations', () => {
  beforeEach(() => vi.resetAllMocks());
  it('rejects missing authentication before looking up sales', async () => {
    expect(
      (await POST(new Request('http://local', { method: 'POST', body: '{}' })))
        .status
    ).toBe(401);
    expect(mocks.admin).not.toHaveBeenCalled();
    expect(mocks.confirm).not.toHaveBeenCalled();
  });
  it('uses the workspace of the hashed integration key, ignoring a supplied workspace', async () => {
    const eq = vi
      .fn()
      .mockReturnValue({
        maybeSingle: async () => ({ data: { account_id: 'workspace' } }),
      });
    mocks.admin.mockReturnValue({ from: () => ({ select: () => ({ eq }) }) });
    mocks.confirm.mockResolvedValue(Response.json({ saved: true }));
    const key = 'a'.repeat(64),
      body = { accountId: 'other', dealId: 'deal' };
    expect(
      (
        await POST(
          new Request('http://local', {
            method: 'POST',
            headers: { Authorization: `Bearer ${key}` },
            body: JSON.stringify(body),
          })
        )
      ).status
    ).toBe(200);
    expect(eq).toHaveBeenCalledWith(
      'secret_hash',
      createHash('sha256').update(key).digest('hex')
    );
    expect(mocks.confirm).toHaveBeenCalledWith(
      body,
      'workspace',
      'payment',
      null
    );
  });
});
