import { NextResponse } from 'next/server'
import { checkCronAuth } from '@/lib/cron-auth'
import { runAiProactive } from '@/lib/ai/proactive'

export const maxDuration = 300

/**
 * AI new-lead outreach + re-engagement sweep. Scheduled by Supabase
 * pg_cron (migration 081) every 5 minutes; same auth as the other cron
 * endpoints.
 */
export async function GET(request: Request) {
  const auth = checkCronAuth(request)
  if (!auth.ok) {
    return NextResponse.json(
      { error: auth.status === 503 ? 'cron not configured' : 'Unauthorized' },
      { status: auth.status },
    )
  }
  const summary = await runAiProactive()
  return NextResponse.json(summary)
}
