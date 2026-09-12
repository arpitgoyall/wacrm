import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Stub the Meta resumable upload so the helper is tested in isolation.
vi.mock('./meta-api', () => ({
  uploadResumableMedia: vi.fn(async () => ({ handle: 'HANDLE123' })),
}));

// The SSRF guard does a real DNS lookup, so stub it — the fixtures below use
// a `.test` hostname that would never resolve. Each test sets the verdict.
vi.mock('@/lib/webhooks/ssrf', () => ({
  isDeliverableUrl: vi.fn(async () => true),
}));

import { ensureMediaHeaderHandle } from './template-header-handle';
import { uploadResumableMedia } from './meta-api';
import { isDeliverableUrl } from '@/lib/webhooks/ssrf';
import type { TemplatePayload } from './template-validators';

function payload(over: Partial<TemplatePayload> = {}): TemplatePayload {
  return {
    name: 't',
    category: 'Utility',
    language: 'en_US',
    body_text: 'hi',
    header_type: 'image',
    header_media_url: 'https://x.test/img.jpg',
    ...over,
  };
}

function fileResponse(type = 'image/jpeg', size = 1024, ok = true, status = 200): Response {
  return {
    ok,
    status,
    headers: { get: (h: string) => (h.toLowerCase() === 'content-type' ? type : null) },
    arrayBuffer: async () => new ArrayBuffer(size),
  } as unknown as Response;
}

describe('ensureMediaHeaderHandle', () => {
  beforeEach(() => {
    vi.mocked(uploadResumableMedia).mockClear();
    vi.mocked(isDeliverableUrl).mockClear();
    vi.mocked(isDeliverableUrl).mockResolvedValue(true);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('is a no-op for non-media headers', async () => {
    const p = payload({ header_type: 'text', header_content: 'Hi' });
    await ensureMediaHeaderHandle(p, 'tok');
    expect(uploadResumableMedia).not.toHaveBeenCalled();
    expect(p.header_handle).toBeUndefined();
  });

  it('is a no-op when a handle already exists', async () => {
    const p = payload({ header_handle: 'existing' });
    await ensureMediaHeaderHandle(p, 'tok');
    expect(uploadResumableMedia).not.toHaveBeenCalled();
    expect(p.header_handle).toBe('existing');
  });

  it('throws an actionable error when META_APP_ID is unset', async () => {
    const p = payload();
    await expect(ensureMediaHeaderHandle(p, 'tok')).rejects.toThrow(/META_APP_ID/);
  });

  it('derives + sets header_handle from a valid image URL', async () => {
    vi.stubEnv('META_APP_ID', 'app-1');
    vi.stubGlobal('fetch', vi.fn(async () => fileResponse('image/jpeg', 2048)));
    const p = payload();
    await ensureMediaHeaderHandle(p, 'tok');
    expect(uploadResumableMedia).toHaveBeenCalledOnce();
    expect(p.header_handle).toBe('HANDLE123');
  });

  it('rejects a non-image content type for an image header', async () => {
    vi.stubEnv('META_APP_ID', 'app-1');
    vi.stubGlobal('fetch', vi.fn(async () => fileResponse('text/html')));
    await expect(ensureMediaHeaderHandle(payload(), 'tok')).rejects.toThrow(/JPEG or PNG/);
  });

  it('rejects an image over 5 MB', async () => {
    vi.stubEnv('META_APP_ID', 'app-1');
    vi.stubGlobal('fetch', vi.fn(async () => fileResponse('image/png', 6 * 1024 * 1024)));
    await expect(ensureMediaHeaderHandle(payload(), 'tok')).rejects.toThrow(/5 MB/);
  });

  // Regression: DOCUMENT (and VIDEO) headers used to fall through this
  // helper's image-only guard, so their `example` never got a Resumable
  // Upload handle — Meta then rejected the create/edit call with "Missing
  // sample parameter... need an example/sample" even though a public
  // header_media_url was set. This is the fix.
  it('derives + sets header_handle from a valid document (PDF) URL', async () => {
    vi.stubEnv('META_APP_ID', 'app-1');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => fileResponse('application/pdf', 4096)),
    );
    const p = payload({
      header_type: 'document',
      header_media_url: 'https://x.test/brochure.pdf',
    });
    await ensureMediaHeaderHandle(p, 'tok');
    expect(uploadResumableMedia).toHaveBeenCalledOnce();
    expect(uploadResumableMedia).toHaveBeenCalledWith(
      expect.objectContaining({ fileName: 'header.pdf', mimeType: 'application/pdf' }),
    );
    expect(p.header_handle).toBe('HANDLE123');
  });

  it('rejects a non-PDF content type for a document header', async () => {
    vi.stubEnv('META_APP_ID', 'app-1');
    vi.stubGlobal('fetch', vi.fn(async () => fileResponse('application/msword')));
    const p = payload({ header_type: 'document', header_media_url: 'https://x.test/doc.docx' });
    await expect(ensureMediaHeaderHandle(p, 'tok')).rejects.toThrow(/PDF/);
  });

  it('rejects a document over 16 MB', async () => {
    vi.stubEnv('META_APP_ID', 'app-1');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => fileResponse('application/pdf', 17 * 1024 * 1024)),
    );
    const p = payload({ header_type: 'document', header_media_url: 'https://x.test/big.pdf' });
    await expect(ensureMediaHeaderHandle(p, 'tok')).rejects.toThrow(/16 MB/);
  });

  it('derives + sets header_handle from a valid video (MP4) URL', async () => {
    vi.stubEnv('META_APP_ID', 'app-1');
    vi.stubGlobal('fetch', vi.fn(async () => fileResponse('video/mp4', 8192)));
    const p = payload({ header_type: 'video', header_media_url: 'https://x.test/clip.mp4' });
    await ensureMediaHeaderHandle(p, 'tok');
    expect(uploadResumableMedia).toHaveBeenCalledWith(
      expect.objectContaining({ fileName: 'header.mp4', mimeType: 'video/mp4' }),
    );
    expect(p.header_handle).toBe('HANDLE123');
  });

  it('rejects a non-video content type for a video header', async () => {
    vi.stubEnv('META_APP_ID', 'app-1');
    vi.stubGlobal('fetch', vi.fn(async () => fileResponse('video/quicktime')));
    const p = payload({ header_type: 'video', header_media_url: 'https://x.test/clip.mov' });
    await expect(ensureMediaHeaderHandle(p, 'tok')).rejects.toThrow(/MP4 or 3GPP/);
  });

  // Regression: `header_media_url` is caller-supplied and any authenticated
  // member can submit a template, so a non-public destination has to be
  // refused *before* the server issues the request — otherwise the status
  // and content-type carried back in the thrown error are an SSRF oracle for
  // loopback, RFC1918 and cloud-metadata addresses.
  it('refuses a non-public header URL without fetching it', async () => {
    vi.stubEnv('META_APP_ID', 'app-1');
    vi.mocked(isDeliverableUrl).mockResolvedValue(false);
    const fetchSpy = vi.fn(async () => fileResponse('application/json'));
    vi.stubGlobal('fetch', fetchSpy);

    const p = payload({ header_media_url: 'http://169.254.169.254/latest/meta-data/' });
    await expect(ensureMediaHeaderHandle(p, 'tok')).rejects.toThrow(/publicly reachable/);

    expect(isDeliverableUrl).toHaveBeenCalledWith('http://169.254.169.254/latest/meta-data/');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(uploadResumableMedia).not.toHaveBeenCalled();
    expect(p.header_handle).toBeUndefined();
  });

  it('reports a blocked URL exactly like an unreachable one', async () => {
    vi.stubEnv('META_APP_ID', 'app-1');

    vi.mocked(isDeliverableUrl).mockResolvedValue(false);
    vi.stubGlobal('fetch', vi.fn(async () => fileResponse()));
    const blocked = await ensureMediaHeaderHandle(payload(), 'tok').catch(
      (e: Error) => e.message,
    );

    vi.mocked(isDeliverableUrl).mockResolvedValue(true);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    );
    const unreachable = await ensureMediaHeaderHandle(payload(), 'tok').catch(
      (e: Error) => e.message,
    );

    expect(blocked).toBe(unreachable);
  });

  it('does not follow redirects, so a public URL cannot bounce to an internal one', async () => {
    vi.stubEnv('META_APP_ID', 'app-1');
    const fetchSpy = vi.fn(async () => fileResponse('image/jpeg', 1024));
    vi.stubGlobal('fetch', fetchSpy);

    await ensureMediaHeaderHandle(payload(), 'tok');

    const init = (fetchSpy.mock.calls[0] as unknown[])[1] as RequestInit;
    expect(init).toMatchObject({ redirect: 'manual' });
  });
});
