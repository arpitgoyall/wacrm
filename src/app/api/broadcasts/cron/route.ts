import { after, NextResponse } from 'next/server';
import { checkCronAuth } from '@/lib/cron-auth';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { deliverBroadcast, finalizeBroadcastStatus } from '@/lib/whatsapp/broadcast-core';
import { claimBroadcastDelivery, markBroadcastSending, planBroadcastResume, releaseBroadcastDelivery } from '@/lib/whatsapp/broadcast-resume';

export const maxDuration = 300;

export async function GET(request: Request) {
  const auth = checkCronAuth(request);
  if (!auth.ok) return NextResponse.json({ error: 'Unauthorized' }, { status: auth.status });

  const db = supabaseAdmin();
  const { data, error } = await db.from('broadcasts').select('id, account_id').eq('status', 'scheduled').lte('scheduled_at', new Date().toISOString()).order('scheduled_at').limit(1);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const claimed: { id: string; accountId: string }[] = [];
  for (const row of data ?? []) {
    if (await claimBroadcastDelivery(db, row.account_id, row.id)) claimed.push({ id: row.id, accountId: row.account_id });
  }

  after(async () => {
    for (const row of claimed) {
      try {
        const { plan, remaining } = await planBroadcastResume(db, row.accountId, row.id, 'pending');
        plan.planned = plan.planned.slice(0, 50);
        await markBroadcastSending(db, row.id);
        await deliverBroadcast(db, plan);
        if (remaining > 0 || plan.planned.length === 50) {
          const { count } = await db.from('broadcast_recipients').select('id', { count: 'exact', head: true }).eq('broadcast_id', row.id).eq('status', 'pending');
          if (count) await db.from('broadcasts').update({ status: 'scheduled' }).eq('id', row.id);
        }
      } catch (error) {
        console.error('[broadcast-cron] delivery failed:', row.id, error);
        await db.from('broadcasts').update({ status: 'failed' }).eq('id', row.id);
        await finalizeBroadcastStatus(db, row.id).catch(() => {});
      } finally {
        await releaseBroadcastDelivery(db, row.id);
      }
    }
  });

  return NextResponse.json({ claimed: claimed.length });
}
