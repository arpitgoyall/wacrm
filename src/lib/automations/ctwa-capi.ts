/**
 * Meta Conversions API for Business Messaging — send a conversion event
 * that attributes a closed deal back to the Click-to-WhatsApp ad the
 * contact arrived from.
 *
 * Used by the `send_meta_capi_event` automation step. The step resolves
 * the deal, contact (`ctwa_clid`), and account credentials
 * (`whatsapp_config.ctwa_dataset_id` / `ctwa_capi_token` / `waba_id`),
 * then calls `sendCtwaConversion` here.
 *
 * Payload shape per Meta's CTWA guidance: `action_source:
 * "business_messaging"`, `messaging_channel: "whatsapp"`, and
 * `user_data.{whatsapp_business_account_id, ctwa_clid}` — without those
 * Meta doesn't recognise the event as coming from a CTWA ad. `event_id`
 * is deterministic (`<deal_id>:<stage_id>:<event_name>`) so a Meta-side
 * retry and our own re-send dedupe to one conversion.
 */

/** Graph API version for the /events endpoint. Bump deliberately. */
export const CTWA_GRAPH_VERSION = 'v21.0'

export interface CtwaConversionInput {
  datasetId: string
  accessToken: string
  wabaId: string
  ctwaClid: string
  eventName: string
  /** Unix seconds. Defaults to now when omitted. */
  eventTime?: number
  /** Deterministic dedup key. Defaults to a random id when omitted. */
  eventId?: string
  value?: number
  currency?: string
  /** Identifies the calling platform in Meta's logs. */
  partnerAgent?: string
}

export interface CtwaConversionEvent {
  event_name: string
  event_time: number
  event_id: string
  action_source: 'business_messaging'
  messaging_channel: 'whatsapp'
  user_data: {
    whatsapp_business_account_id: string
    ctwa_clid: string
  }
  custom_data?: {
    value?: number
    currency?: string
  }
}

export interface CtwaConversionBody {
  data: CtwaConversionEvent[]
  partner_agent?: string
}

/**
 * Build the request body for the /events call. Pure — no network, no
 * clock unless `eventTime` is omitted — so the step's assembly logic is
 * unit-testable. `custom_data` is included only when there's a value or
 * currency to send (a bare `Lead` event carries neither).
 */
export function buildCtwaConversionBody(
  input: CtwaConversionInput,
): CtwaConversionBody {
  const event: CtwaConversionEvent = {
    event_name: input.eventName,
    event_time: input.eventTime ?? Math.floor(Date.now() / 1000),
    event_id:
      input.eventId ??
      `${input.eventName}:${Math.random().toString(36).slice(2)}`,
    action_source: 'business_messaging',
    messaging_channel: 'whatsapp',
    user_data: {
      whatsapp_business_account_id: input.wabaId,
      ctwa_clid: input.ctwaClid,
    },
  }

  const hasValue = typeof input.value === 'number' && !Number.isNaN(input.value)
  if (hasValue || input.currency) {
    event.custom_data = {}
    if (hasValue) event.custom_data.value = input.value
    if (input.currency) event.custom_data.currency = input.currency
  }

  const body: CtwaConversionBody = { data: [event] }
  if (input.partnerAgent) body.partner_agent = input.partnerAgent
  return body
}

export interface CtwaConversionResult {
  ok: boolean
  status: number
  /** Meta's response body, parsed when JSON, raw string otherwise. */
  body: unknown
}

/**
 * POST the event to `graph.facebook.com/<ver>/<datasetId>/events`. The
 * access token goes in the body (not the querystring) so it isn't
 * logged in transit. Never throws — returns `{ ok:false }` with the
 * status/body so the step can record the failure without aborting the
 * rest of the automation run.
 */
export async function sendCtwaConversion(
  input: CtwaConversionInput,
): Promise<CtwaConversionResult> {
  const url = `https://graph.facebook.com/${CTWA_GRAPH_VERSION}/${encodeURIComponent(
    input.datasetId,
  )}/events`
  const body = {
    ...buildCtwaConversionBody(input),
    access_token: input.accessToken,
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    })
    const text = await res.text()
    let parsed: unknown = text
    try {
      parsed = JSON.parse(text)
    } catch {
      /* leave as raw text */
    }
    return { ok: res.ok, status: res.status, body: parsed }
  } catch (err) {
    return {
      ok: false,
      status: 0,
      body: err instanceof Error ? err.message : String(err),
    }
  }
}
