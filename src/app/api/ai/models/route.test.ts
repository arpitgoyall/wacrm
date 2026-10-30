import { afterEach, describe, expect, it, vi } from 'vitest';
import { GET } from './route';

vi.mock('@/lib/auth/account', () => ({
  getCurrentAccount: vi.fn().mockResolvedValue({ userId: 'user' }),
  toErrorResponse: () =>
    Response.json({ error: 'Unauthorized' }, { status: 401 }),
}));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: () => ({ success: true }),
  rateLimitResponse: vi.fn(),
  RATE_LIMITS: { adminAction: {} },
}));

afterEach(() => vi.unstubAllGlobals());

describe('free OpenRouter catalog', () => {
  it('excludes paid, unpriced, and non-text models', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          Response.json({
            data: [
              {
                id: 'free',
                name: 'Free',
                pricing: { prompt: '0', completion: '0' },
              },
              { id: 'paid', pricing: { prompt: '0', completion: '0.01' } },
              { id: 'unknown' },
              {
                id: 'image',
                pricing: { prompt: '0', completion: '0' },
                architecture: { output_modalities: ['image'] },
              },
            ],
          })
        )
    );
    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      models: [{ id: 'free', name: 'Free' }],
    });
  });

  it('returns a retryable error when OpenRouter is unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network')));
    expect((await GET()).status).toBe(502);
  });

  it('requires authentication before fetching the catalog', async () => {
    const { getCurrentAccount } = await import('@/lib/auth/account');
    vi.mocked(getCurrentAccount).mockRejectedValueOnce(
      new Error('unauthorized')
    );
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect((await GET()).status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
