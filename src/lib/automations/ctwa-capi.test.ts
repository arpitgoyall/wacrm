import { describe, it, expect } from 'vitest'
import { buildCtwaConversionBody, CTWA_GRAPH_VERSION } from './ctwa-capi'

describe('buildCtwaConversionBody', () => {
  const base = {
    datasetId: 'ds_1',
    accessToken: 'tok',
    wabaId: 'waba_9',
    ctwaClid: 'clid_abc',
    eventName: 'Purchase',
    eventTime: 1_700_000_000,
    eventId: 'deal1:stage2:Purchase',
  }

  it('shapes the event with the CTWA-required attribution fields', () => {
    const body = buildCtwaConversionBody({ ...base, value: 4999, currency: 'INR' })
    expect(body).toEqual({
      data: [
        {
          event_name: 'Purchase',
          event_time: 1_700_000_000,
          event_id: 'deal1:stage2:Purchase',
          action_source: 'business_messaging',
          messaging_channel: 'whatsapp',
          user_data: {
            whatsapp_business_account_id: 'waba_9',
            ctwa_clid: 'clid_abc',
          },
          custom_data: { value: 4999, currency: 'INR' },
        },
      ],
    })
  })

  it('omits custom_data entirely for a value-less event (e.g. Lead)', () => {
    const body = buildCtwaConversionBody({ ...base, eventName: 'Lead' })
    expect(body.data[0].custom_data).toBeUndefined()
  })

  it('includes custom_data with only currency, or only value', () => {
    expect(
      buildCtwaConversionBody({ ...base, currency: 'USD' }).data[0].custom_data,
    ).toEqual({ currency: 'USD' })
    expect(
      buildCtwaConversionBody({ ...base, value: 10 }).data[0].custom_data,
    ).toEqual({ value: 10 })
  })

  it('drops a NaN value', () => {
    const body = buildCtwaConversionBody({ ...base, value: Number.NaN })
    expect(body.data[0].custom_data).toBeUndefined()
  })

  it('adds partner_agent only when supplied', () => {
    expect(buildCtwaConversionBody(base).partner_agent).toBeUndefined()
    expect(
      buildCtwaConversionBody({ ...base, partnerAgent: 'wacrm' }).partner_agent,
    ).toBe('wacrm')
  })

  it('defaults event_time to now and event_id to something unique when omitted', () => {
    const { eventTime: _t, eventId: _i, ...noTime } = base
    void _t
    void _i
    const a = buildCtwaConversionBody(noTime)
    const b = buildCtwaConversionBody(noTime)
    expect(a.data[0].event_time).toBeGreaterThan(1_600_000_000)
    expect(a.data[0].event_id).not.toBe(b.data[0].event_id)
  })

  it('pins a known Graph API version', () => {
    expect(CTWA_GRAPH_VERSION).toMatch(/^v\d+\.\d+$/)
  })
})
