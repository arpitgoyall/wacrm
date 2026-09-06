# Running with Docker

The repo ships a multi-stage `Dockerfile` (Next.js standalone output,
runs as a non-root user) and a `docker-compose.yml` with a single
`app` service. Supabase is external — point the app at your hosted
(or self-hosted) Supabase project via env vars; no database container
is included.

## Quick start

1. Copy the env template and fill it in:

   ```bash
   cp .env.local.example .env.local
   ```

2. Build and start (the `--env-file` flag is required — Compose only
   reads `.env` by default for `${VAR}` substitution, and this project
   keeps its config in `.env.local`):

   ```bash
   docker compose --env-file .env.local up --build -d
   ```

3. The app is served on [http://localhost:3000](http://localhost:3000)
   (publish it elsewhere with `HOST_PORT=8080` in `.env.local`).

> Use `HOST_PORT`, not `PORT`, to move the published port. `PORT` is
> what the server listens on _inside_ the container, and `env_file`
> would inject it there — leaving the app on a port the mapping and
> the healthcheck don't target. Compose pins it to 3000 for that
> reason.

## Build-time vs runtime variables

- `NEXT_PUBLIC_*` variables are **inlined into the client bundle at
  build time**. They are passed as Docker build args by
  `docker-compose.yml`. If you change any of them, rebuild:
  `docker compose --env-file .env.local up --build -d`.
- Everything else (`SUPABASE_SERVICE_ROLE_KEY`, `ENCRYPTION_KEY`,
  `META_APP_SECRET`, …) is read at **runtime** from `.env.local` via
  `env_file` and is never baked into the image — safe to change with
  just a container restart.

## Plain Docker (no Compose)

```bash
docker build \
  --build-arg NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co \
  --build-arg NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key \
  -t wacrm .

docker run -d --env-file .env.local -e PORT=3000 -p 3000:3000 wacrm
```

## Notes

- Database migrations under `supabase/` are **not** run by the
  container — apply them with the Supabase CLI as described in the
  README.
- Received attachments are copied into the `chat-media` Supabase
  Storage bucket, because Meta deletes media roughly 30 days after it
  arrives and the copy is the only thing that outlives that. It grows
  with inbound volume, so it's worth watching your project's storage
  quota. Turn it off per account under Settings → WhatsApp →
  Attachment Storage; attachments received while it's off become
  unviewable once Meta drops them. Files over 16 MB (the bucket's
  limit) are never copied.
- Nothing inside the container is scheduled. If you use automation
  Wait steps, `deal_stage_changed` automations, or flows, point an
  external scheduler at `GET /api/automations/cron` (Wait steps +
  deal-stage-change triggers) and `GET /api/flows/cron` (stale-run
  sweep) on this deployment, sending the shared secret in the
  `x-cron-secret` header (`AUTOMATION_CRON_SECRET`, see
  `.env.local.example`). Both return 503 until that variable is set.
  Run `/api/automations/cron` every minute or two; `/api/flows/cron`
  every 10-15 minutes is plenty.
- On **Vercel**, `vercel.json` `crons` (already checked in) triggers
  both endpoints — set `CRON_SECRET` in the project env and Vercel
  sends it as `Authorization: Bearer` automatically. The checked-in
  schedules are **once daily** (`0 3 * * *` / `0 4 * * *`) because
  Vercel **Hobby rejects any sub-daily cron expression at deploy
  time**. Daily is fine for `deal_stage_changed` → Meta conversions
  (attribution windows are days) but means automation Wait steps and
  flow timeouts only advance once a day. For minute-level cadence,
  either upgrade to **Pro** and change the schedules to `* * * * *`,
  or leave Vercel's cron daily and additionally point an external
  every-few-minutes pinger at the same URLs with the `x-cron-secret`
  header. The `/api/automations/cron` handler drains its full backlog
  per run (batched, ~45s budget), so a daily run still clears a whole
  day of events.
