import { NextResponse } from 'next/server'
import { checkCronAuth } from '@/lib/cron-auth'
import { GET as runAutomations } from '@/app/api/automations/cron/route'
import { GET as runFlows } from '@/app/api/flows/cron/route'
import { GET as runBroadcasts } from '@/app/api/broadcasts/cron/route'

export const maxDuration = 300

/** One Vercel Hobby schedule for the three independent maintenance jobs. */
export async function GET(request: Request) {
  const auth = checkCronAuth(request)
  if (!auth.ok) {
    return NextResponse.json(
      { error: auth.status === 503 ? 'cron not configured' : 'Unauthorized' },
      { status: auth.status },
    )
  }

  const jobs = [
    ['automations', runAutomations],
    ['flows', runFlows],
    ['broadcasts', runBroadcasts],
  ] as const
  const results = await Promise.allSettled(
    jobs.map(async ([name, run]) => {
      const response = await run(request)
      return { name, status: response.status, body: await response.json() }
    }),
  )
  const summary = results.map((result, index) =>
    result.status === 'fulfilled'
      ? result.value
      : {
          name: jobs[index][0],
          status: 500,
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        },
  )
  return NextResponse.json(
    { jobs: summary },
    { status: summary.some((job) => job.status >= 400) ? 500 : 200 },
  )
}
