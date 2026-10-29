import { supabaseAdmin } from '@/lib/automations/admin-client';
import { graph } from './graph';
import { connectionToken } from './workspace';

// Never retry an ambiguous creation until an administrator supplies its actual Meta ID.
export async function reconcileCampaignChange(
  accountId: string,
  id: string,
  suppliedId?: string
) {
  const db = supabaseAdmin();
  const { data: change } = await db
    .from('ads_change_requests')
    .select('*')
    .eq('account_id', accountId)
    .eq('id', id)
    .in('status', ['uncertain', 'processing'])
    .maybeSingle();
  if (!change)
    throw Error('Only an uncertain or interrupted operation can be reconciled');
  if (
    change.status === 'processing' &&
    Date.now() - Date.parse(change.approved_at || change.created_at) < 300_000
  )
    throw Error(
      'This operation may still be running. Wait five minutes before reconciliation.'
    );
  const { connection, token } = await connectionToken(
    accountId,
    change.connection_id
  );
  const remote = { ...change.remote_ids };
  if (change.action === 'publish' && remote.inflight) {
    if (remote.inflight === 'image') {
      // Re-uploading an image cannot start spend or create another campaign.
      remote.inflight = null;
    } else {
      if (!suppliedId || !/^\d+$/.test(suppliedId))
        throw Error(
          `Supply the actual Meta ID created for step ${remote.inflight}. Do not resume without checking Meta.`
        );
      const actual = await graph(suppliedId, token, {
        fields:
          remote.inflight === 'adset'
            ? 'id,name,account_id,campaign_id'
            : remote.inflight === 'ad'
              ? 'id,name,account_id,adset_id'
              : 'id,name,account_id',
      });
      if (`act_${actual.account_id}` !== connection.meta_account_id)
        throw Error('This Meta object belongs to a different ad account');
      const d = change.after_data.draft;
      const expected =
        remote.inflight === 'campaign'
          ? d.name
          : remote.inflight === 'adset'
            ? `${d.name} · WhatsApp`
            : d.headline;
      if (actual.name !== expected)
        throw Error(
          'The Meta object name does not match the interrupted creation step'
        );
      if (remote.inflight === 'adset' && actual.campaign_id !== remote.campaign)
        throw Error('Ad set belongs to a different campaign');
      if (remote.inflight === 'ad' && actual.adset_id !== remote.adset)
        throw Error('Ad belongs to a different ad set');
      remote[remote.inflight] = suppliedId;
      remote.inflight = null;
    }
  } else if (change.action === 'duplicate') {
    if (!suppliedId || !/^\d+$/.test(suppliedId))
      throw Error('Supply the copied campaign ID after checking Meta');
    const actual = await graph(suppliedId, token, {
      fields: 'id,account_id,status',
    });
    if (
      `act_${actual.account_id}` !== connection.meta_account_id ||
      actual.status !== 'PAUSED'
    )
      throw Error(
        'The copied campaign must belong to this account and be paused'
      );
    const { error } = await db
      .from('ads_change_requests')
      .update({
        status: 'applied',
        remote_ids: { ...remote, reconciledId: suppliedId },
        error: null,
      })
      .eq('id', id)
      .eq('account_id', accountId);
    if (error) throw error;
    return { reconciled: true };
  }
  const { error } = await db
    .from('ads_change_requests')
    .update({
      status: 'failed',
      remote_ids: remote,
      error: 'Reconciled. Review and resume the remaining operation.',
    })
    .eq('id', id)
    .eq('account_id', accountId);
  if (error) throw error;
  return { reconciled: true };
}
