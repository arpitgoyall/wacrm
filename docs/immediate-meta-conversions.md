# Immediate Meta deal-stage conversions

Meta conversion reporting is built in and does not use the automation builder
or a cron job:

- `Qualified` sends the standard `Lead` event.
- `Enrolled` sends the standard `Purchase` event with the deal value and INR.

Only deals carrying a Click-to-WhatsApp `ctwa_clid` are eligible. The account
must also have its dataset ID, CAPI token, and WABA ID configured in WhatsApp
settings. A deal/stage/event tuple is sent at most once.

## One-time Supabase Database Webhook setup

1. Deploy migration `065_immediate_meta_stage_events.sql` and the application.
2. Set a long random `DEAL_STAGE_WEBHOOK_SECRET` in the application environment.
3. In Supabase, create a Database Webhook on `public.deal_stage_events` for
   `INSERT` events.
4. Set its URL to `https://<your-app>/api/webhooks/deal-stage`.
5. Add the HTTP header `x-webhook-secret` with exactly the same secret.

The route makes up to three immediate Meta requests. A final failure is stored
on the event row as `delivery_status = 'failed'`; there is intentionally no
scheduled retry or cron fallback.
