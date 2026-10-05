import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import type { Deal } from '@/types';
import { loadPipelineDeals } from './load-deals';

function deal(index: number): Deal {
  return {
    id: `deal-${index}`,
    user_id: 'creator',
    pipeline_id: 'pipeline-1',
    stage_id: 'stage-1',
    contact_id: `contact-${index}`,
    title: `Lead ${index}`,
    value: 0,
    created_at: '2026-10-05T00:00:00Z',
  };
}

function database(rows: Deal[], failPage = false, failInbox = false) {
  const query = {
    select: vi.fn(),
    eq: vi.fn(),
    order: vi.fn(),
    range: vi.fn(),
  };
  query.select.mockReturnValue(query);
  query.eq.mockReturnValue(query);
  query.order.mockReturnValue(query);
  query.range.mockImplementation(async (from: number, to: number) => ({
    data: rows.slice(from, to + 1),
    error: failPage && from > 0 ? { message: 'Page failed' } : null,
  }));
  const inbox = { select: vi.fn(), in: vi.fn(), order: vi.fn() };
  inbox.select.mockReturnValue(inbox);
  let contactIds: string[] = [];
  inbox.in.mockImplementation((_column: string, ids: string[]) => {
    contactIds = ids;
    return inbox;
  });
  inbox.order.mockImplementation(async () => ({
    data: contactIds.map((id) => ({ id: `inbox-${id}`, contact_id: id })),
    error: failInbox ? { message: 'Inbox lookup failed' } : null,
  }));
  const from = vi.fn((table: string) => (table === 'deals' ? query : inbox));
  return { client: { from } as unknown as SupabaseClient, from, query, inbox };
}

describe('loadPipelineDeals', () => {
  it('includes leads and inbox links beyond the default Supabase result cap', async () => {
    const rows = Array.from({ length: 1001 }, (_, index) => deal(index));
    const db = database(rows);
    const result = await loadPipelineDeals(db.client, 'pipeline-1');
    expect(result).toHaveLength(1001);
    expect(result[1000]).toMatchObject({
      id: 'deal-1000',
      conversation_id: 'inbox-contact-1000',
    });
    expect(db.query.eq).toHaveBeenCalledWith('pipeline_id', 'pipeline-1');
    expect(db.inbox.in.mock.calls.every(([, ids]) => ids.length <= 200)).toBe(
      true
    );
  });

  it('preserves direct inbox links for a deal without a contact', async () => {
    const row = {
      ...deal(0),
      contact_id: null,
      conversation_id: 'direct-inbox',
    };
    const db = database([row]);
    expect(await loadPipelineDeals(db.client, 'pipeline-1')).toEqual([row]);
    expect(db.from).not.toHaveBeenCalledWith('conversations');
  });

  it('rejects an incomplete result when a later page fails', async () => {
    const db = database(
      Array.from({ length: 1001 }, (_, index) => deal(index)),
      true
    );
    await expect(loadPipelineDeals(db.client, 'pipeline-1')).rejects.toThrow(
      'Page failed'
    );
  });

  it('reports inbox lookup failures instead of displaying incorrect links', async () => {
    const db = database([deal(0)], false, true);
    await expect(loadPipelineDeals(db.client, 'pipeline-1')).rejects.toThrow(
      'Inbox lookup failed'
    );
  });
});
