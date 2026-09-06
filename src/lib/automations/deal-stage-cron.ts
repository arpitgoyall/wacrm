import { supabaseAdmin } from './admin-client'
import { runAutomationsForTrigger } from './engine'

/**
 * Drain the `deal_stage_events` outbox (migration 050) and fire the
 * `deal_stage_changed` automation trigger for each row.
 *
 * Rows are written by the AFTER UPDATE trigger on `deals` whenever a
 * deal's `stage_id` changes — so every stage move (pipeline board drag,
 * inbox stage control, deal form) is covered without those client-side
 * writes needing to know about automations.
 *
 * Called from `GET /api/automations/cron` (same schedule as the Wait-step
 * drainer) so operators have one fewer endpoint to schedule. The claim
 * (`processed_at` set with an `IS NULL` precondition) is the lock against
 * overlapping invocations. A row whose dispatch throws is still marked
 * processed — automation steps are best-effort, and the CAPI step's own
 * idempotency guard (`ctwa_conversion_dispatches`) handles genuine
 * retries via a repeated stage move.
 *
 * Returns the number of events processed this pass.
 */
export async function drainDealStageEvents(): Promise<number> {
  const admin = supabaseAdmin()

  const { data: events, error } = await admin
    .from('deal_stage_events')
    .select(
      'id, account_id, deal_id, contact_id, pipeline_id, from_stage_id, to_stage_id',
    )
    .is('processed_at', null)
    .order('created_at', { ascending: true })
    .limit(50)

  if (error) {
    console.error('[deal-stage-cron] scan failed:', error.message)
    return 0
  }
  if (!events || events.length === 0) return 0

  type Row = {
    id: string
    account_id: string
    deal_id: string
    contact_id: string | null
    pipeline_id: string | null
    from_stage_id: string | null
    to_stage_id: string
  }

  let processed = 0
  for (const ev of events as Row[]) {
    // Claim — skip if another invocation already took it.
    const { data: claim } = await admin
      .from('deal_stage_events')
      .update({ processed_at: new Date().toISOString() })
      .eq('id', ev.id)
      .is('processed_at', null)
      .select('id')
      .maybeSingle()
    if (!claim) continue

    // Snapshot the deal columns the trigger's steps / interpolation need.
    const { data: deal } = await admin
      .from('deals')
      .select('value, currency, title')
      .eq('id', ev.deal_id)
      .eq('account_id', ev.account_id)
      .maybeSingle()

    try {
      await runAutomationsForTrigger({
        accountId: ev.account_id,
        triggerType: 'deal_stage_changed',
        contactId: ev.contact_id,
        context: {
          deal_id: ev.deal_id,
          deal_pipeline_id: ev.pipeline_id ?? undefined,
          deal_from_stage_id: ev.from_stage_id ?? undefined,
          deal_to_stage_id: ev.to_stage_id,
          deal_value: deal?.value == null ? undefined : Number(deal.value),
          deal_currency: (deal?.currency as string | null) ?? undefined,
          deal_title: (deal?.title as string | null) ?? undefined,
        },
      })
    } catch (err) {
      // runAutomationsForTrigger is documented never to throw; guard
      // anyway so one bad row can't stall the rest of the batch.
      console.error(
        '[deal-stage-cron] dispatch failed for event',
        ev.id,
        err instanceof Error ? err.message : err,
      )
    }
    processed += 1
  }

  return processed
}
