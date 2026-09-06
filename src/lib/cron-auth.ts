import { timingSafeEqual } from 'node:crypto'

/**
 * Shared auth gate for the scheduled cron endpoints
 * (`/api/automations/cron`, `/api/flows/cron`).
 *
 * Two accepted credentials, either one is enough:
 *
 *   1. `x-cron-secret: <AUTOMATION_CRON_SECRET>` — for an external
 *      pinger / GitHub Actions / self-hosted crontab (the original
 *      mechanism; still supported).
 *
 *   2. `Authorization: Bearer <CRON_SECRET>` — what Vercel Cron Jobs
 *      send automatically when a `CRON_SECRET` env var is set on the
 *      project. Vercel cron cannot send arbitrary custom headers, so
 *      this is the only way its native scheduler can authenticate.
 *
 * Returns `{ ok: true }` when a supplied credential matches, otherwise
 * `{ ok: false, status }` — 503 if neither secret is configured at all
 * (nothing to check against), 401 if configured but not matched.
 */
export function checkCronAuth(request: Request):
  | { ok: true }
  | { ok: false; status: 401 | 503 } {
  const cronSecret = process.env.CRON_SECRET
  const legacySecret = process.env.AUTOMATION_CRON_SECRET
  if (!cronSecret && !legacySecret) {
    return { ok: false, status: 503 }
  }

  // Constant-time compare; length pre-check is required by
  // timingSafeEqual and leaks only length, which isn't sensitive.
  const safeEqual = (supplied: string, expected: string): boolean => {
    const a = Buffer.from(supplied)
    const b = Buffer.from(expected)
    return a.length === b.length && timingSafeEqual(a, b)
  }

  const bearer = request.headers.get('authorization') ?? ''
  const bearerToken = bearer.startsWith('Bearer ') ? bearer.slice(7) : ''
  if (cronSecret && bearerToken && safeEqual(bearerToken, cronSecret)) {
    return { ok: true }
  }

  const headerSecret = request.headers.get('x-cron-secret') ?? ''
  if (legacySecret && headerSecret && safeEqual(headerSecret, legacySecret)) {
    return { ok: true }
  }

  return { ok: false, status: 401 }
}
