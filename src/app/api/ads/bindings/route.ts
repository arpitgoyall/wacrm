import { NextResponse } from 'next/server';
import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/automations/admin-client';

// Ad → Flow bindings (migration 054).
//
//   GET  /api/ads/bindings   — list this account's bindings
//   PUT  /api/ads/bindings   — set or clear one binding:
//        { match_type, match_value, flow_id|automation_id }
//        exactly one target; neither → clear the binding.
//
// GET is member-readable (RLS-scoped client). PUT is admin+ and writes
// through the service-role client, so the role check lives here.

const MATCH_TYPES = new Set(['ad', 'campaign']);

export async function GET() {
  try {
    const { supabase } = await getCurrentAccount();
    const { data, error } = await supabase
      .from('ctwa_ad_bindings')
      .select(
        'id, match_type, match_value, flow_id, automation_id, is_active, updated_at'
      );
    if (error)
      return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ bindings: data ?? [] });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PUT(request: Request) {
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

  const matchType = String(body.match_type ?? '');
  const matchValue = String(body.match_value ?? '').trim();
  if (!MATCH_TYPES.has(matchType) || !matchValue) {
    return NextResponse.json(
      {
        error:
          'match_type must be "ad" or "campaign" and match_value is required',
      },
      { status: 400 }
    );
  }

  const flowId = body.flow_id ? String(body.flow_id) : null;
  const automationId = body.automation_id ? String(body.automation_id) : null;
  if (flowId && automationId) {
    return NextResponse.json(
      { error: 'set flow_id OR automation_id, not both' },
      { status: 400 }
    );
  }

  const admin = supabaseAdmin();

  // Neither target → clear the binding.
  if (!flowId && !automationId) {
    const { error } = await admin
      .from('ctwa_ad_bindings')
      .delete()
      .eq('account_id', ctx.accountId)
      .eq('match_type', matchType)
      .eq('match_value', matchValue);
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    return NextResponse.json({ binding: null });
  }

  // The service-role client bypasses RLS — confirm the target belongs to
  // this account before pointing a binding at it.
  const targetTable = flowId ? 'flows' : 'automations';
  const targetId = flowId ?? automationId;
  const { data: target } = await admin
    .from(targetTable)
    .select('id')
    .eq('id', targetId)
    .eq('account_id', ctx.accountId)
    .maybeSingle();
  if (!target) {
    return NextResponse.json(
      { error: `${flowId ? 'flow' : 'automation'} not found` },
      { status: 404 }
    );
  }

  const { data, error } = await admin
    .from('ctwa_ad_bindings')
    .upsert(
      {
        account_id: ctx.accountId,
        match_type: matchType,
        match_value: matchValue,
        flow_id: flowId,
        automation_id: automationId,
        is_active: true,
        created_by: ctx.userId,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'account_id,match_type,match_value' }
    )
    .select(
      'id, match_type, match_value, flow_id, automation_id, is_active, updated_at'
    )
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ binding: data });
}
