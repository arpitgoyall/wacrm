import { NextResponse } from 'next/server';
import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/automations/admin-client';

export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount();
    const { data, error } = await supabase
      .from('ad_reporting_settings')
      .select('max_cpl, min_roas')
      .eq('account_id', accountId)
      .maybeSingle();
    if (error)
      return NextResponse.json(
        { error: 'Could not load workspace targets' },
        { status: 500 }
      );
    return NextResponse.json({
      targets: data ?? { max_cpl: null, min_roas: null },
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PUT(request: Request) {
  try {
    const ctx = await requireRole('admin');
    const body = await request.json().catch(() => null);
    if (
      !body ||
      !['max_cpl', 'min_roas'].every(
        (k) =>
          body[k] === null ||
          (typeof body[k] === 'number' &&
            Number.isFinite(body[k]) &&
            body[k] > 0)
      )
    ) {
      return NextResponse.json(
        { error: 'Targets must be positive numbers or null' },
        { status: 400 }
      );
    }
    const { data, error } = await supabaseAdmin()
      .from('ad_reporting_settings')
      .upsert({
        account_id: ctx.accountId,
        max_cpl: body.max_cpl,
        min_roas: body.min_roas,
        updated_at: new Date().toISOString(),
      })
      .select('max_cpl, min_roas')
      .single();
    if (error)
      return NextResponse.json(
        { error: 'Could not save workspace targets' },
        { status: 500 }
      );
    return NextResponse.json({ targets: data });
  } catch (err) {
    return toErrorResponse(err);
  }
}
