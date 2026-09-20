import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { dispatchBuiltInDealStageConversion } from '@/lib/meta/deal-stage-conversions'

export const runtime = 'nodejs'
export const maxDuration = 30

interface DatabaseWebhookBody {
  type?: string
  table?: string
  record?: { id?: string }
}

function validSecret(request: Request): boolean {
  const expected = process.env.DEAL_STAGE_WEBHOOK_SECRET
  const supplied = request.headers.get('x-webhook-secret')
  if (!expected || !supplied) return false
  const a = Buffer.from(expected)
  const b = Buffer.from(supplied)
  return a.length === b.length && timingSafeEqual(a, b)
}

export async function POST(request: Request) {
  if (!process.env.DEAL_STAGE_WEBHOOK_SECRET) {
    return NextResponse.json({ error: 'deal-stage webhook is not configured' }, { status: 503 })
  }
  if (!validSecret(request)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  let body: DatabaseWebhookBody
  try {
    body = (await request.json()) as DatabaseWebhookBody
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 })
  }

  const eventId = body.record?.id
  if (body.type !== 'INSERT' || body.table !== 'deal_stage_events' || !eventId) {
    return NextResponse.json({ error: 'invalid deal-stage webhook payload' }, { status: 400 })
  }

  const db = supabaseAdmin()
  const { data: claim, error: claimError } = await db
    .from('deal_stage_events')
    .update({
      delivery_status: 'processing',
      attempt_count: 1,
      last_error: null,
    })
    .eq('id', eventId)
    .eq('delivery_status', 'pending')
    .select('id')
    .maybeSingle()

  if (claimError) {
    return NextResponse.json({ error: claimError.message }, { status: 500 })
  }
  if (!claim) {
    return NextResponse.json({ accepted: true, duplicate: true })
  }

  const result = await dispatchBuiltInDealStageConversion(eventId)
  const update =
    result.status === 'failed'
      ? { delivery_status: 'failed', processed_at: new Date().toISOString(), last_error: result.error }
      : {
          delivery_status: result.status,
          processed_at: new Date().toISOString(),
          last_error: result.status === 'skipped' ? result.reason : null,
        }
  await db.from('deal_stage_events').update(update).eq('id', eventId)

  if (result.status === 'failed') {
    return NextResponse.json({ error: result.error, event: result.eventName }, { status: 502 })
  }
  return NextResponse.json({ accepted: true, ...result })
}
