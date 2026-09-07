import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/automations/admin-client';

// PATCH /api/ads/[id] — rename a CTWA ad in the registry (migration
// 051). `label` is the only user-editable field; everything else on
// the row is refreshed from inbound webhook traffic. Admin+ only,
// mirroring the RLS `ctwa_ads_update` policy — the write goes through
// the service-role client so the role check has to live here.

const MAX_LABEL_LEN = 120;

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  let ctx;
  try {
    ctx = await requireRole('admin');
  } catch (err) {
    return toErrorResponse(err);
  }

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  if (!('label' in body)) {
    return NextResponse.json({ error: 'label is required' }, { status: 400 });
  }

  // An empty string clears the label (falls back to showing the ad id).
  const raw = body.label;
  if (raw !== null && typeof raw !== 'string') {
    return NextResponse.json(
      { error: 'label must be a string or null' },
      { status: 400 }
    );
  }
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (trimmed.length > MAX_LABEL_LEN) {
    return NextResponse.json(
      { error: `label must be ${MAX_LABEL_LEN} characters or fewer` },
      { status: 400 }
    );
  }
  const label = trimmed.length > 0 ? trimmed : null;

  const { data, error } = await supabaseAdmin()
    .from('ctwa_ads')
    .update({ label })
    .eq('id', id)
    .eq('account_id', ctx.accountId)
    .select(
      'id, source_id, label, headline, body, source_url, source_type, first_seen_at, last_seen_at'
    )
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!data) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  return NextResponse.json({ ad: data });
}
