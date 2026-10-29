import { describe, it, expect, vi, afterEach } from 'vitest';
import { graph, graphPages, GraphError } from './graph';
afterEach(() => vi.unstubAllGlobals());
describe('Meta transport', () => {
  it('uses a bearer header and follows only cursor values on the fixed Meta host', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          data: [{ id: '1' }],
          paging: {
            next: 'https://untrusted.invalid/steal',
            cursors: { after: 'cursor' },
          },
        })
      )
      .mockResolvedValueOnce(Response.json({ data: [{ id: '2' }] }));
    vi.stubGlobal('fetch', fetch);
    expect(await graphPages('me/adaccounts', 'secret')).toEqual([
      { id: '1' },
      { id: '2' },
    ]);
    expect(String(fetch.mock.calls[1][0])).toContain('graph.facebook.com');
    expect(String(fetch.mock.calls[1][0])).toContain('after=cursor');
    expect(
      new URL(fetch.mock.calls[1][0]).searchParams.has('access_token')
    ).toBe(false);
    expect(fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer secret');
  });
  it('marks rate limits and server errors transient', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          Response.json(
            { error: { message: 'Slow down', code: 4 } },
            { status: 429 }
          )
        )
    );
    try {
      await graph('act_1', 'secret');
      throw Error('Expected failure');
    } catch (e) {
      expect(e).toBeInstanceOf(GraphError);
      expect((e as GraphError).transient).toBe(true);
    }
  });
  it('rejects unsupported paths before any request and refuses broken pagination', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        Response.json({ data: [], paging: { next: 'https://example.com' } })
      );
    vi.stubGlobal('fetch', fetch);
    await expect(graph('https://example.com', 'token')).rejects.toThrow(
      'Invalid'
    );
    expect(fetch).not.toHaveBeenCalled();
    await expect(graphPages('me/adaccounts', 'token')).rejects.toThrow(
      'cursor'
    );
  });
});
