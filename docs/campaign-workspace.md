# WhatsApp campaign workspace

## Setup and rollout

1. Back up the database and apply migrations **072 through 077 in order** using the project's normal Supabase migration process. The migrations are idempotent. They have been exercised against an isolated PostgreSQL-compatible database, not the deployment database.
2. Keep the existing `ENCRYPTION_KEY` and server-only Supabase service role configured. Rotating that key without re-encrypting stored tokens disconnects integrations.
3. Set `META_APP_ID`, `META_APP_SECRET`, and `NEXT_PUBLIC_APP_URL` to the deployment origin. Register `<origin>/api/ads/oauth/callback` as a valid Meta OAuth redirect URI. `META_ADS_GRAPH_VERSION` defaults to `v26.0` and can be pinned explicitly.
4. Configure and obtain the Meta permissions required by your app and business assets. The advertising connection flow requests `ads_read`, `ads_management`, `business_management`, `pages_show_list`, and `pages_read_engagement`; the existing WhatsApp integration supplies WhatsApp asset access separately. Actual access remains subject to Meta approval, asset assignment, and account eligibility. Read-only credentials can report; management requires granted advertising management access.
5. Open **Ads → Settings**, connect/select accounts, and synchronize. Each connection retains its own currency, timezone and history coverage. Reconnect can also use a server-encrypted access token. Existing legacy ads reports remain at `/ads/legacy`.
6. Use history backfill repeatedly to extend coverage by seven days per request. Normal sync refreshes the latest 30 days. CRM attribution cannot be reconstructed before recorded click events; fallback leads are labeled.
7. Schedule authenticated `GET /api/ads/cron` at least once per minute for qualification and conversion queues. Use the existing cron authentication (`Authorization: Bearer <CRON_SECRET>` or the configured automation cron header). Each call evaluates up to 20 dirty contacts, delivers up to 10 conversion events and syncs up to two due accounts. Increase invocation frequency/capacity for larger installations. The existing daily cron is a fallback, not a real-time delivery schedule.
8. Configure the default WhatsApp identity, dataset and encrypted conversion token in the existing WhatsApp settings. Publishing checks that the selected Page's WhatsApp number matches the receiving integration. Multiple advertising accounts are supported; multiple independent receiving WhatsApp integrations are not introduced here.
9. Validate in a connected test account before enabling this for customers. Local tests mock Meta requests and never launch campaigns. Validate reporting first, then outcome delivery, then paused campaign creation and reviewed management.

## Data definitions

- Lead acquisition uses contact creation time in the selected advertising account's timezone. The earliest recorded click near creation supplies original acquisition; otherwise current attribution is explicitly a fallback. Later interactions remain in `ctwa_click_events`.
- Qualifications and confirmed sales use their actual recorded outcome dates. Legacy deal creation/won reports remain separate. Journey tiles are period activity, not a single cohort conversion rate.
- Engagement means at least two customer messages in a conversation whose first customer message falls in the period. Human reply time measures the first staff response from the first customer message; bot responses are recorded separately. Follow-up attempts are flow attempts, not proof of delivery or task completion.
- Spend is in the selected ad account currency. Revenue in another currency makes ROAS unavailable. No automatic FX conversion or cross-account currency summation occurs.
- Budget baseline is the **current daily budget × selected days**, not historical budget reconstruction, a pacing forecast, or Meta's billing limit.
- Workspace aggregates are available to members; contact drill-down follows CRM visibility. Administrators manage connections, business rules, documents and advertising. Assigned sales agents can confirm outcomes; other members read reports.

## Qualification and conversion delivery

Rules apply prospectively to new or subsequently updated records after the rule version's effective time. Saving rules does not scan or send all existing contacts. Staff overrides are preserved. Configure stage IDs, custom CRM field IDs and chatbot variable names in Settings.

Qualified contacts and sales have separate stable conversion identities. A durable outbox, compare-and-set claims, expiring leases and exponential retries survive restarts. A confirmed API acknowledgement means **delivered to Meta**, not attributed by Meta. Missing click IDs or credentials are skipped with reasons. Administrators may request a retry after fixing configuration. Qualification duplicates and repeated sale notifications retain the same conversion identity.

Sale corrections and refunds update CRM reporting and retain an audit trail. An undelivered purchase is skipped if its sale has been refunded. Already accepted Meta events cannot be reversed by this UI; corrections/refunds are not represented as new purchase events. Review delivery diagnostics when reconciling refunds. The health panel counts retry attempts and duplicate outcomes suppressed among the 200 most recent events.

## External sale confirmations

Generate an integration key in Ads Settings. It is shown once and stored only as a SHA-256 hash. Rotation invalidates the old key. Keep it server-side in the payment/order integration.

Send `POST /api/ads/payments` with `Authorization: Bearer <key>` and JSON:

```json
{
  "contactId": "workspace-contact-uuid",
  "dealId": "workspace-deal-uuid",
  "value": 2499.5,
  "currency": "INR",
  "status": "confirmed",
  "occurredAt": "2026-10-25T09:30:00Z"
}
```

Use `status: "refunded"` for a refund/correction to the same deal. The workspace comes from the key, never the request body. The deal must belong to that contact and workspace. One deal identifies one sale; model separate purchases as separate deals. Repeated staff and integration confirmations do not add sales. Integration confirmation takes precedence over staff confirmation. This endpoint authenticates the sending integration; provider-specific signature verification remains the responsibility of that connector.

## Reviewed campaign operations

The wizard supports standard WhatsApp engagement campaigns, country/age targeting, daily budgets, schedules, an HTTPS image URL or existing Meta video ID, copy and a receiving qualification flow. Unsupported regulated campaign categories are rejected. Additional account-specific targeting and placement controls require separate verified support; the preview is illustrative.

Save drafts, prepare a review, inspect existing/proposed values and spending implications, then approve. New objects are created paused and activated only if explicitly reviewed. Pause/resume, daily budget changes, paused duplication and per-item bulk status changes use the same audit trail. Draft revisions and current Meta values are checked before applying.

If a creation response is ambiguous, the operation is marked uncertain. Do not repeatedly publish. Check Meta and supply the actual created object ID in the review to reconcile before resuming. Interrupted operations can be reconciled after five minutes. Successfully created IDs are retained so remaining steps can resume.

## Reporting and experiments

The workspace provides selectable metrics, saved views/reports, CSV export, campaign annotations, creative records/reuse, and experiment records with hypothesis, variants, primary metric and evaluation dates. Recommendations show observed evidence, sample size, comparison period and limitations. They are guidance; acceptance records a decision and never changes campaigns automatically. Experiments are records for manual evaluation, not automated random allocation or statistical significance testing.

## Validation included

Targeted unit tests cover reporting dates/timezones, attribution fallback, currency separation, recommendations, pagination, rule evaluation, review preparation/approval, stale values, duplicate approval and uncertain publishing. API tests cover permission gates and integration workspace scoping. Isolated database checks cover repeat migration application, RLS, credential isolation, sale deduplication, payment precedence, refunds, event identity and atomic insight replacement. Live permission approval, account eligibility, spend reconciliation and publishing must still be checked against the deployment's test account.
