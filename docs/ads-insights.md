# Ads insights, Phase 1

Apply `supabase/migrations/072_ads_insights.sql` before deploying this version. It creates the workspace targets table and reporting indexes. Attribution history uses the existing `ctwa_click_events` table from migration 052, already written by the WhatsApp webhook; no fabricated historical attribution is backfilled.

The Ads page defaults to the last 30 days, including today. Choose 7, 30, 90 days, custom inclusive dates, or all time. CRM activity uses UTC calendar dates; Meta insights retain Meta reporting dates. Daily charts show spend and contacts created, with separate axes. Funnel counts are independent activity metrics, not a cohort: deals created during the period can belong to older leads. Won deals and revenue use deal creation date and current status, so they can change when deals close later.

Each contact counts as one lead. The earliest recorded ad click establishes the acquisition ad only when its timestamp is no later than five minutes after contact creation (allowing webhook processing delay). Later taps remain in history and cannot move that acquisition source. Contacts without this history fall back to their current ad and are explicitly counted as incomplete attribution. Deal snapshots take precedence; manual deals without snapshots use the latest recorded click before deal creation, then contact attribution as a fallback.

Spend history grows from the first successful sync and is refreshed over a rolling 30-day window. Older selections may be incomplete. Reports identify history coverage, failed reads, missing syncs, and syncs older than two hours. Reports page through database responses rather than relying on the default row limit.

Spend is displayed in its recorded Meta currency. Revenue stays in workspace currency. Mixed or unknown spend currencies cannot be combined for display. ROAS, CPL, and cost-per-deal comparisons are suppressed unless spend and workspace currencies match; there is no implicit currency conversion.

All workspace members can read targets. The authenticated admin route saves positive maximum CPL and minimum ROAS values; null clears a target. Browser-only targets from earlier versions are not automatically published as workspace settings. Up to five flags identify ads with spend but no CRM leads, above-target CPL, or below-target ROAS. Flags never change Meta campaigns.

Validation: `npx vitest run src/lib/ads/reporting.test.ts src/lib/ads/performance.test.ts src/app/api/ads/targets/route.test.ts`, `npm run typecheck`, and ESLint on the modified TypeScript files.
