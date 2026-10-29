import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/automations/admin-client';
export async function confirmSale(
  body: Record<string, unknown>,
  accountId: string,
  source: 'staff' | 'payment',
  actorId: string | null
) {
  if (
    typeof body.contactId !== 'string' ||
    typeof body.dealId !== 'string' ||
    typeof body.value !== 'number' ||
    !Number.isFinite(body.value) ||
    body.value < 0 ||
    typeof body.currency !== 'string' ||
    !/^[A-Z]{3}$/.test(body.currency) ||
    !['confirmed', 'refunded'].includes(String(body.status || 'confirmed'))
  )
    return NextResponse.json(
      {
        error:
          'Provide a contact, deal, amount, currency and confirmation status',
      },
      { status: 400 }
    );
  const occurredAt = body.occurredAt
    ? String(body.occurredAt)
    : new Date().toISOString();
  if (
    !Number.isFinite(Date.parse(occurredAt)) ||
    Date.parse(occurredAt) > Date.now() + 60_000
  )
    return NextResponse.json(
      { error: 'Sale time is invalid' },
      { status: 400 }
    );
  const { data, error } = await supabaseAdmin().rpc('ads_confirm_sale', {
    p_account: accountId,
    p_contact: body.contactId,
    p_deal: body.dealId,
    p_key: `deal:${body.dealId}`,
    p_value: body.value,
    p_currency: body.currency,
    p_source: source,
    p_status: body.status || 'confirmed',
    p_actor: actorId,
    p_time: occurredAt,
  });
  if (error)
    return NextResponse.json(
      {
        error:
          'Sale could not be confirmed. Check that the deal and contact belong to this workspace.',
      },
      { status: 400 }
    );
  return NextResponse.json({ sale: data });
}
