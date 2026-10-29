import { supabaseAdmin } from '@/lib/automations/admin-client';
import { connectionToken } from './workspace';
import { graph, graphPages, GraphError, type GraphObject } from './graph';
import { moneyScale } from './workspace-report';
import { decrypt } from '@/lib/whatsapp/encryption';

export interface CampaignDraft {
  connectionId: string;
  name: string;
  goal: 'qualified' | 'sales';
  pageId: string;
  whatsapp: string;
  country: string;
  ageMin: number;
  ageMax: number;
  dailyBudget: number;
  start: string;
  end: string;
  headline: string;
  message: string;
  openingMessage: string;
  imageUrl: string;
  videoId?: string;
  flowId?: string;
  launch: boolean;
  specialCategories?: string[];
}
export function validateDraft(raw: unknown): asserts raw is CampaignDraft {
  const d = raw as CampaignDraft;
  if (
    !d ||
    !d.connectionId ||
    !d.name?.trim() ||
    !['qualified', 'sales'].includes(d.goal) ||
    !/^\d+$/.test(d.pageId) ||
    !/^\+?\d{7,15}$/.test(d.whatsapp) ||
    !/^[A-Z]{2}$/.test(d.country) ||
    !Number.isInteger(d.ageMin) ||
    !Number.isInteger(d.ageMax) ||
    d.ageMin < 18 ||
    d.ageMax < d.ageMin ||
    d.ageMax > 65 ||
    !Number.isFinite(d.dailyBudget) ||
    d.dailyBudget <= 0 ||
    !d.headline?.trim() ||
    !d.message?.trim() ||
    !/^https:\/\//.test(d.imageUrl) ||
    (d.videoId && !/^\d+$/.test(d.videoId)) ||
    typeof d.launch !== 'boolean'
  )
    throw Error(
      'Complete the campaign identity, audience, budget, and creative before review'
    );
  if (
    !Number.isFinite(Date.parse(d.start)) ||
    !Number.isFinite(Date.parse(d.end)) ||
    Date.parse(d.end) <= Math.max(Date.parse(d.start), Date.now())
  )
    throw Error('Choose a valid future campaign schedule');
  if (d.specialCategories?.length)
    throw Error(
      'Regulated categories require category-specific targeting. Create these campaigns in Meta until those controls are supported.'
    );
}
export async function campaignIdentities(
  accountId: string,
  connectionId: string
) {
  const { connection, token } = await connectionToken(accountId, connectionId);
  const pages = await graphPages<{
    id: string;
    name: string;
    whatsapp_number?: string;
  }>('me/accounts', token, { fields: 'id,name,whatsapp_number' });
  const { data: wa } = await supabaseAdmin()
    .from('whatsapp_config')
    .select('phone_number_id,access_token')
    .eq('account_id', accountId)
    .maybeSingle();
  let connectedWhatsAppNumber: string | null = null;
  if (wa?.phone_number_id && wa.access_token) {
    const phone = await graph<{ display_phone_number?: string }>(
      String(wa.phone_number_id),
      decrypt(wa.access_token),
      { fields: 'display_phone_number' }
    );
    connectedWhatsAppNumber =
      phone.display_phone_number?.replace(/\D/g, '') || null;
  }
  return {
    pages,
    connectedWhatsAppNumber,
    canManage: connection.permissions.includes('ads_management'),
  };
}
export async function prepareCampaignChange(
  accountId: string,
  actorId: string,
  body: Record<string, unknown>
) {
  const { connection, token } = await connectionToken(
    accountId,
    String(body.connectionId)
  );
  if (!connection.permissions.includes('ads_management'))
    throw Error('Reconnect Meta with campaign management permission');
  const action = String(body.action),
    db = supabaseAdmin();
  let before: GraphObject = {},
    after: GraphObject = {},
    entityId = String(body.entityId || '');
  if (action === 'publish') {
    const { data: document } = await db
      .from('ads_documents')
      .select('*')
      .eq('account_id', accountId)
      .eq('id', body.draftId)
      .eq('kind', 'draft')
      .single();
    if (!document) throw Error('Draft not found');
    validateDraft(document.data);
    if (document.data.connectionId !== connection.id)
      throw Error('Draft belongs to a different ad account');
    const { pages, connectedWhatsAppNumber } = await campaignIdentities(
      accountId,
      connection.id
    );
    const page = pages.find((p) => p.id === document.data.pageId);
    if (
      !connectedWhatsAppNumber ||
      connectedWhatsAppNumber !== document.data.whatsapp.replace(/\D/g, '') ||
      !page?.whatsapp_number ||
      page.whatsapp_number.replace(/\D/g, '') !==
        document.data.whatsapp.replace(/\D/g, '')
    )
      throw Error(
        'Select a Page linked to the chosen WhatsApp number. Meta must return its linked number before this campaign can be published.'
      );
    if (document.data.flowId) {
      const { data: flow } = await db
        .from('flows')
        .select('id')
        .eq('id', document.data.flowId)
        .eq('account_id', accountId)
        .eq('status', 'active')
        .maybeSingle();
      if (!flow) throw Error('The selected qualification flow is not active');
    }
    // Meta validates the campaign objective without creating or spending.
    await graph(
      `${connection.meta_account_id}/campaigns`,
      token,
      {
        name: document.name,
        objective: 'OUTCOME_ENGAGEMENT',
        special_ad_categories: [],
        status: 'PAUSED',
        is_adset_budget_sharing_enabled: false,
        execution_options: ['validate_only'],
      },
      'POST'
    );
    entityId = document.id;
    before = { revision: document.revision };
    after = { draft: document.data };
    const { data: existing } = await db
      .from('ads_change_requests')
      .select('*')
      .eq('account_id', accountId)
      .eq('entity_id', entityId)
      .eq('action', 'publish')
      .in('status', ['review', 'processing', 'uncertain', 'applied'])
      .limit(1)
      .maybeSingle();
    if (existing) return existing;
  } else {
    if (!['status', 'budget', 'duplicate'].includes(action))
      throw Error('Unsupported campaign change');
    const { data: entity } = await db
      .from('ads_entities')
      .select('*')
      .eq('account_id', accountId)
      .eq('connection_id', connection.id)
      .eq('meta_id', entityId)
      .maybeSingle();
    if (!entity) throw Error('Campaign item not found in this account');
    before = await graph(entityId, token, {
      fields:
        entity.kind === 'ad'
          ? 'id,name,status,account_id'
          : 'id,name,status,daily_budget,account_id',
    });
    if (`act_${before.account_id}` !== connection.meta_account_id)
      throw Error('Meta account ownership does not match');
    if (action === 'status') {
      if (!['ACTIVE', 'PAUSED'].includes(String(body.status)))
        throw Error('Choose Active or Paused');
      after = { status: body.status };
    } else if (action === 'budget') {
      if (
        entity.kind === 'ad' ||
        !before.daily_budget ||
        typeof body.budget !== 'number' ||
        !Number.isFinite(body.budget) ||
        body.budget <= 0
      )
        throw Error('Edit an existing daily budget on a campaign or ad set');
      after = {
        daily_budget: Math.round(body.budget * moneyScale(connection.currency)),
      };
    } else {
      if (entity.kind !== 'campaign')
        throw Error(
          'Duplicate the whole campaign to preserve its ad sets and creatives'
        );
      after = { deep_copy: true, status_option: 'PAUSED' };
    }
  }
  const { data, error } = await db
    .from('ads_change_requests')
    .insert({
      account_id: accountId,
      connection_id: connection.id,
      entity_id: entityId,
      action,
      before_data: before,
      after_data: after,
      actor_id: actorId,
    })
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

export async function applyCampaignChange(
  accountId: string,
  id: string,
  actorId: string
) {
  const db = supabaseAdmin();
  const { data: request, error } = await db
    .from('ads_change_requests')
    .update({
      status: 'processing',
      error: null,
      approved_by: actorId,
      approved_at: new Date().toISOString(),
    })
    .eq('id', id)
    .eq('account_id', accountId)
    .in('status', ['review', 'failed'])
    .select('*')
    .maybeSingle();
  if (error) throw error;
  if (!request)
    throw Error(
      'This change is already processing, applied, or needs reconciliation'
    );
  const { connection, token } = await connectionToken(
    accountId,
    request.connection_id
  ).catch(async (err) => {
    await db
      .from('ads_change_requests')
      .update({
        status: 'failed',
        error: 'Reconnect the ad account before applying this review',
      })
      .eq('id', id)
      .eq('account_id', accountId);
    throw err;
  });
  if (!connection.permissions.includes('ads_management')) {
    await db
      .from('ads_change_requests')
      .update({
        status: 'failed',
        error: 'Reconnect Meta with management permission',
      })
      .eq('id', id);
    throw Error('Management permission is unavailable');
  }
  const checkpoint = async (remoteIds: GraphObject) => {
    const { error } = await db
      .from('ads_change_requests')
      .update({ remote_ids: remoteIds })
      .eq('id', id)
      .eq('account_id', accountId);
    if (error) throw error;
  };
  let remote: GraphObject = request.remote_ids || {},
    writing = false;
  try {
    if (request.action === 'publish') {
      const d = request.after_data.draft as CampaignDraft;
      validateDraft(d);
      const create = async (key: string, path: string, params: GraphObject) => {
        if (remote[key]) return String(remote[key]);
        if (remote.inflight)
          throw Error(
            'A previous publish response is uncertain. Reconcile its Meta object before continuing.'
          );
        remote = { ...remote, inflight: key };
        await checkpoint(remote);
        writing = true;
        const result = await graph<{ id: string }>(path, token, params, 'POST');
        if (!result.id)
          throw Error('Meta did not return the created object identifier');
        remote = { ...remote, [key]: result.id, inflight: null };
        await checkpoint(remote);
        writing = false;
        return result.id;
      };
      const campaign = await create(
        'campaign',
        `${connection.meta_account_id}/campaigns`,
        {
          name: d.name,
          objective: 'OUTCOME_ENGAGEMENT',
          special_ad_categories: [],
          status: 'PAUSED',
          is_adset_budget_sharing_enabled: false,
        }
      );
      const adset = await create(
        'adset',
        `${connection.meta_account_id}/adsets`,
        {
          name: `${d.name} · WhatsApp`,
          campaign_id: campaign,
          destination_type: 'WHATSAPP',
          optimization_goal: 'CONVERSATIONS',
          billing_event: 'IMPRESSIONS',
          bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
          daily_budget: Math.round(
            d.dailyBudget * moneyScale(connection.currency)
          ),
          promoted_object: {
            page_id: d.pageId,
            whatsapp_phone_number: d.whatsapp,
          },
          targeting: {
            geo_locations: { countries: [d.country] },
            age_min: d.ageMin,
            age_max: d.ageMax,
            targeting_automation: { advantage_audience: 0 },
          },
          start_time: d.start,
          end_time: d.end,
          status: 'PAUSED',
        }
      );
      let imageHash = String(remote.imageHash || '');
      if (!d.videoId && !imageHash) {
        remote = { ...remote, inflight: 'image' };
        await checkpoint(remote);
        writing = true;
        const image = await graph<{ images: Record<string, { hash: string }> }>(
          `${connection.meta_account_id}/adimages`,
          token,
          { url: d.imageUrl },
          'POST'
        );
        imageHash = Object.values(image.images || {})[0]?.hash;
        if (!imageHash) throw Error('Meta did not accept the image');
        remote = { ...remote, imageHash, inflight: null };
        await checkpoint(remote);
        writing = false;
      }
      const cta = {
        type: 'WHATSAPP_MESSAGE',
        value: {
          app_destination: 'WHATSAPP',
          link: `https://wa.me/${d.whatsapp.replace(/\D/g, '')}?text=${encodeURIComponent(d.openingMessage || '')}`,
        },
      };
      const story = d.videoId
        ? {
            page_id: d.pageId,
            video_data: {
              video_id: d.videoId,
              image_url: d.imageUrl,
              title: d.headline,
              message: d.message,
              call_to_action: cta,
            },
          }
        : {
            page_id: d.pageId,
            link_data: {
              image_hash: imageHash,
              link: cta.value.link,
              name: d.headline,
              message: d.message,
              call_to_action: cta,
            },
          };
      const creative = await create(
        'creative',
        `${connection.meta_account_id}/adcreatives`,
        { name: d.headline, object_story_spec: story }
      );
      const ad = await create('ad', `${connection.meta_account_id}/ads`, {
        name: d.headline,
        adset_id: adset,
        creative: { creative_id: creative },
        status: 'PAUSED',
      });
      if (d.flowId) {
        const { error } = await db.from('ctwa_ad_bindings').upsert(
          {
            account_id: accountId,
            match_type: 'ad',
            match_value: ad,
            flow_id: d.flowId,
            automation_id: null,
            is_active: true,
            created_by: request.actor_id,
          },
          { onConflict: 'account_id,match_type,match_value' }
        );
        if (error) throw error;
      }
      // Activation is the last operation and only follows the explicitly reviewed launch setting.
      if (d.launch) {
        writing = true;
        for (const entity of [ad, adset, campaign])
          await graph(entity, token, { status: 'ACTIVE' }, 'POST');
        writing = false;
      }
      remote = {
        ...remote,
        actual: await graph(campaign, token, {
          fields: 'id,status,effective_status',
        }),
      };
    } else {
      const before = request.before_data as GraphObject,
        after = request.after_data as GraphObject;
      const current = await graph(request.entity_id, token, {
        fields:
          request.action === 'budget'
            ? 'id,daily_budget,account_id'
            : 'id,status,account_id',
      });
      if (`act_${current.account_id}` !== connection.meta_account_id)
        throw Error('Meta account ownership changed');
      const key = request.action === 'budget' ? 'daily_budget' : 'status';
      if (
        request.action !== 'duplicate' &&
        String(current[key]) !== String(before[key]) &&
        String(current[key]) !== String(after[key])
      )
        throw Error(
          'Campaign changed since review. Prepare a new review before applying.'
        );
      writing = true;
      const result = await graph(
        request.action === 'duplicate'
          ? `${request.entity_id}/copies`
          : request.entity_id,
        token,
        after,
        'POST'
      );
      remote = { result };
      await checkpoint(remote);
      writing = false;
      if (request.action !== 'duplicate')
        remote.actual = await graph(request.entity_id, token, {
          fields: 'id,status,effective_status',
        });
    }
    const { error } = await db
      .from('ads_change_requests')
      .update({ status: 'applied', remote_ids: remote, error: null })
      .eq('id', id)
      .eq('account_id', accountId);
    if (error) throw error;
    return { applied: true, remote };
  } catch (err) {
    const definiteRejection = err instanceof GraphError && !err.transient;
    if (definiteRejection && remote.inflight) {
      remote = { ...remote, inflight: null };
    }
    const message =
      err instanceof Error ? err.message : 'Campaign change failed';
    await db
      .from('ads_change_requests')
      .update({
        status: writing && !definiteRejection ? 'uncertain' : 'failed',
        remote_ids: remote,
        error: message.slice(0, 1000),
      })
      .eq('id', id)
      .eq('account_id', accountId);
    throw Error(message);
  }
}
