import { supabaseAdmin } from '@/lib/automations/admin-client';
import { decrypt, encrypt } from '@/lib/whatsapp/encryption';
import { graphPages, type GraphObject } from './graph';
import type { SupabaseClient } from '@supabase/supabase-js';

export interface AdConnection {
  id: string;
  account_id: string;
  meta_account_id: string;
  name: string;
  currency: string;
  timezone: string;
  permissions: string[];
  status: string;
  error: string | null;
  synced_at: string | null;
  history_start: string | null;
  backfill_until: string | null;
  sync_claimed_at: string | null;
}
export async function connectionToken(accountId: string, id: string) {
  const db = supabaseAdmin();
  const { data: connection, error } = await db
    .from('ads_connections')
    .select('*')
    .eq('account_id', accountId)
    .eq('id', id)
    .single();
  if (error || !connection)
    throw Error('Ad account is not connected to this workspace');
  const { data: secret } = await db
    .from('ads_connection_secrets')
    .select('token')
    .eq('connection_id', id)
    .single();
  if (!secret) throw Error('Reconnect this ad account');
  return {
    connection: connection as AdConnection,
    token: decrypt(secret.token),
  };
}
export async function discoverAccounts(token: string) {
  return graphPages<{
    id: string;
    name: string;
    currency: string;
    timezone_name: string;
    account_status: number;
    user_tasks?: string[];
  }>('me/adaccounts', token, {
    fields: 'id,name,currency,timezone_name,account_status,user_tasks',
  });
}
export async function saveConnection(
  accountId: string,
  token: string,
  metaId: string
) {
  if (!/^act_\d+$/.test(metaId)) throw Error('Select a valid Meta ad account');
  const accounts = await discoverAccounts(token);
  const found = accounts.find((a) => a.id === metaId);
  if (!found) throw Error('Your Meta login cannot access this ad account');
  const permissions = await graphPages<{ permission: string; status: string }>(
    'me/permissions',
    token
  );
  const granted = permissions
    .filter((p) => p.status === 'granted')
    .map((p) => p.permission);
  if (!granted.some((p) => p === 'ads_read' || p === 'ads_management'))
    throw Error('Meta login needs ads_read or ads_management access');
  const db = supabaseAdmin();
  const { data, error } = await db
    .from('ads_connections')
    .upsert(
      {
        account_id: accountId,
        meta_account_id: found.id,
        name: found.name,
        currency: found.currency,
        timezone: found.timezone_name,
        permissions: granted,
        status: found.account_status === 1 ? 'connected' : 'restricted',
        error: null,
      },
      { onConflict: 'account_id,meta_account_id' }
    )
    .select('*')
    .single();
  if (error) throw error;
  const { error: secretError } = await db
    .from('ads_connection_secrets')
    .upsert({ connection_id: data.id, token: encrypt(token) });
  if (secretError) throw secretError;
  return data;
}
export interface CampaignEntity {
  id: string;
  connection_id: string;
  meta_id: string;
  kind: 'campaign' | 'adset' | 'ad';
  parent_id: string | null;
  name: string;
  status: string;
  data: GraphObject;
}
export async function allRows<T>(
  table: string,
  accountId: string,
  extra?: { key: string; value: string }
) {
  const rows: T[] = [];
  for (let offset = 0; ; offset += 1000) {
    let query = supabaseAdmin()
      .from(table)
      .select('*')
      .eq('account_id', accountId)
      .order('id')
      .range(offset, offset + 999);
    if (extra) query = query.eq(extra.key, extra.value);
    const { data, error } = await query;
    if (error) throw error;
    rows.push(...(data as T[]));
    if (data.length < 1000) return rows;
  }
}

export async function scopedRows<T>(
  db: SupabaseClient,
  table: string,
  accountId: string,
  columns: string
) {
  const rows: T[] = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await db
      .from(table)
      .select(columns)
      .eq('account_id', accountId)
      .order('id')
      .range(offset, offset + 999);
    if (error) throw error;
    rows.push(...(data as unknown as T[]));
    if (data.length < 1000) return rows;
  }
}
