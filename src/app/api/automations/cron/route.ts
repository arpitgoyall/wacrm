import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { resumePendingExecution } from '@/lib/automations/engine'
import type { AutomationContext } from '@/lib/automations/engine'
import { drainDealStageEvents } from '@/lib/automations/deal-stage-cron'
import { checkCronAuth } from '@/lib/cron-auth'

// The pending-executions + deal-stage loops can each make up to 50
// iterations, some with an outbound Meta call — give the function room
// past the default so a busy minute doesn't get cut off mid-batch.
export const maxDuration = 60

/**
 * Two jobs, one schedule:
 *
 *   1. Drain due `automation_pending_executions` rows (Wait steps whose
 *      timer has elapsed).
 *   2. Drain the `deal_stage_events` outbox (migration 050) → fire the
 *      `deal_stage_changed` trigger. Folded in here rather than a
 *      separate endpoint so there's one fewer cron for operators to
 *      schedule (Vercel Hobby allows only 2 cron jobs total).
 *
 * Auth: `Authorization: Bearer $CRON_SECRET` (Vercel Cron) OR
 * `x-cron-secret: $AUTOMATION_CRON_SECRET` (external pinger). See
 * `checkCronAuth`. Returns 503 until at least one secret is set.
 *
 * The claim step (status = 'running' / `processed_at` set) is the lock
 * so overlapping invocations don't double-process.
 */
export async function GET(request: Request) {
  const auth = checkCronAuth(request)
  if (!auth.ok) {
    return NextResponse.json(
      { error: auth.status === 503 ? 'cron not configured' : 'Unauthorized' },
      { status: auth.status },
    )
  }

  const admin = supabaseAdmin()
  const { data: due, error } = await admin
    .from('automation_pending_executions')
    .select('*')
    .eq('status', 'pending')
    .lte('run_at', new Date().toISOString())
    .order('run_at', { ascending: true })
    .limit(50)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  let processed = 0
  for (const row of due ?? []) {
    const { data: claim } = await admin
      .from('automation_pending_executions')
      .update({ status: 'running' })
      .eq('id', row.id)
      .eq('status', 'pending')
      .select('id')
      .maybeSingle()
    if (!claim) continue

    await resumePendingExecution({
      id: row.id as string,
      automation_id: row.automation_id as string,
      // account_id is NOT NULL on automation_pending_executions
      // post-017; the engine uses it for tenant-scoped lookups.
      account_id: row.account_id as string,
      user_id: row.user_id as string,
      contact_id: (row.contact_id as string | null) ?? null,
      log_id: (row.log_id as string | null) ?? null,
      parent_step_id: (row.parent_step_id as string | null) ?? null,
      branch: (row.branch as 'yes' | 'no' | null) ?? null,
      next_step_position: row.next_step_position as number,
      context: (row.context as AutomationContext) ?? {},
    })
    processed++
  }

  // Deal-stage-change outbox → `deal_stage_changed` automations.
  const dealStageProcessed = await drainDealStageEvents()

  return NextResponse.json({ processed, dealStageProcessed })
}
