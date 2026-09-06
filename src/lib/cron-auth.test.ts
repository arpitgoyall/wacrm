import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkCronAuth } from './cron-auth'

const req = (headers: Record<string, string>) =>
  new Request('https://x/api/automations/cron', { headers })

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('checkCronAuth', () => {
  it('503s when neither secret is configured', () => {
    vi.stubEnv('CRON_SECRET', '')
    vi.stubEnv('AUTOMATION_CRON_SECRET', '')
    expect(checkCronAuth(req({}))).toEqual({ ok: false, status: 503 })
  })

  it('accepts Vercel-style Authorization: Bearer <CRON_SECRET>', () => {
    vi.stubEnv('CRON_SECRET', 'vercel-secret')
    vi.stubEnv('AUTOMATION_CRON_SECRET', '')
    expect(
      checkCronAuth(req({ authorization: 'Bearer vercel-secret' })),
    ).toEqual({ ok: true })
  })

  it('accepts the legacy x-cron-secret header', () => {
    vi.stubEnv('CRON_SECRET', '')
    vi.stubEnv('AUTOMATION_CRON_SECRET', 'pinger-secret')
    expect(checkCronAuth(req({ 'x-cron-secret': 'pinger-secret' }))).toEqual({
      ok: true,
    })
  })

  it('honours both mechanisms when both secrets are set', () => {
    vi.stubEnv('CRON_SECRET', 'a')
    vi.stubEnv('AUTOMATION_CRON_SECRET', 'b')
    expect(checkCronAuth(req({ authorization: 'Bearer a' }))).toEqual({ ok: true })
    expect(checkCronAuth(req({ 'x-cron-secret': 'b' }))).toEqual({ ok: true })
  })

  it('401s on a wrong or missing credential when a secret is configured', () => {
    vi.stubEnv('CRON_SECRET', 'right')
    vi.stubEnv('AUTOMATION_CRON_SECRET', '')
    expect(checkCronAuth(req({ authorization: 'Bearer wrong' }))).toEqual({
      ok: false,
      status: 401,
    })
    expect(checkCronAuth(req({}))).toEqual({ ok: false, status: 401 })
    expect(checkCronAuth(req({ 'x-cron-secret': 'right' }))).toEqual({
      ok: false,
      status: 401,
    })
  })

  it('does not treat an empty bearer token as a match against an empty check', () => {
    vi.stubEnv('CRON_SECRET', 'set')
    vi.stubEnv('AUTOMATION_CRON_SECRET', '')
    expect(checkCronAuth(req({ authorization: 'Bearer ' }))).toEqual({
      ok: false,
      status: 401,
    })
  })
})
