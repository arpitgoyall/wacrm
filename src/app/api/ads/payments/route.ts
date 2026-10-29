import { createHash } from 'node:crypto';
import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/automations/admin-client';
import { confirmSale } from '@/lib/ads/sale-confirmation';

export async function POST(request: Request) {
  const key =
    request.headers.get('authorization')?.replace(/^Bearer /, '') || '';
  if (!/^[a-f0-9]{64}$/.test(key))
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { data: integration } = await supabaseAdmin()
    .from('ads_integration_keys')
    .select('account_id')
    .eq('secret_hash', createHash('sha256').update(key).digest('hex'))
    .maybeSingle();
  if (!integration)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object')
    return NextResponse.json(
      { error: 'Invalid payment confirmation' },
      { status: 400 }
    );
  return confirmSale(body, integration.account_id, 'payment', null);
}
