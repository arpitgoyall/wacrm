import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  role: vi.fn(),
  prepare: vi.fn(),
  apply: vi.fn(),
  identities: vi.fn(),
  reconcile: vi.fn(),
  admin: vi.fn(),
}));
vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.role,
  toErrorResponse: () => Response.json({ error: 'Forbidden' }, { status: 403 }),
}));
vi.mock('@/lib/ads/campaign-actions', () => ({
  prepareCampaignChange: mocks.prepare,
  applyCampaignChange: mocks.apply,
  campaignIdentities: mocks.identities,
}));
vi.mock('@/lib/ads/campaign-reconcile', () => ({
  reconcileCampaignChange: mocks.reconcile,
}));
vi.mock('@/lib/automations/admin-client', () => ({
  supabaseAdmin: mocks.admin,
}));
import { GET, POST } from './route';
const request = (body: unknown) =>
  new Request('http://local/api/ads/actions', {
    method: 'POST',
    body: JSON.stringify(body),
  });
describe('campaign change permissions and review boundary', () => {
  beforeEach(() => vi.resetAllMocks());
  it('rejects reads and writes without advertising administration access', async () => {
    mocks.role.mockRejectedValue(Error('Forbidden'));
    expect((await GET(new Request('http://local?connection=one'))).status).toBe(
      403
    );
    expect(
      (await POST(request({ approve: true, requestId: 'one' }))).status
    ).toBe(403);
    expect(mocks.apply).not.toHaveBeenCalled();
    expect(mocks.admin).not.toHaveBeenCalled();
  });
  it('prepares a review without applying the requested campaign change', async () => {
    mocks.role.mockResolvedValue({ accountId: 'workspace', userId: 'actor' });
    mocks.prepare.mockResolvedValue({ id: 'review' });
    expect(
      (await POST(request({ action: 'status', accountId: 'other' }))).status
    ).toBe(200);
    expect(mocks.prepare).toHaveBeenCalledWith(
      'workspace',
      'actor',
      expect.any(Object)
    );
    expect(mocks.apply).not.toHaveBeenCalled();
    expect(mocks.role).toHaveBeenCalledWith('admin');
  });
  it('applies only an explicitly approved stored review in the authenticated workspace', async () => {
    mocks.role.mockResolvedValue({ accountId: 'workspace', userId: 'actor' });
    mocks.apply.mockResolvedValue({ applied: true });
    expect(
      (
        await POST(
          request({ approve: true, requestId: 'review', accountId: 'other' })
        )
      ).status
    ).toBe(200);
    expect(mocks.apply).toHaveBeenCalledWith('workspace', 'review', 'actor');
    expect(mocks.prepare).not.toHaveBeenCalled();
  });
});
