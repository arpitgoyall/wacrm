import { confirmSale } from '@/lib/ads/sale-confirmation';
import { randomBytes, createHash } from 'node:crypto';
import { NextResponse } from 'next/server';
import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
  ForbiddenError,
} from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/automations/admin-client';
import {
  allRows,
  scopedRows,
  type AdConnection,
  type CampaignEntity,
} from '@/lib/ads/workspace';
import {
  campaignReport,
  campaignRecommendations,
  previousPeriod,
  type DailyInsight,
  type ReportContact,
  type Qualification,
  type Sale,
  type ConversationMilestone,
  type FlowJourney,
} from '@/lib/ads/workspace-report';
import { evaluateWorkspaceRules } from '@/lib/ads/qualification';

export const maxDuration = 60;
export async function GET(request: Request) {
  try {
    const ctx = await getCurrentAccount(),
      db = ctx.supabase;
    const url = new URL(request.url),
      id = url.searchParams.get('connection') || '';
    const start = url.searchParams.get('start') || '',
      end = url.searchParams.get('end') || '';
    let previous: { start: string; end: string };
    try {
      previous = previousPeriod(start, end);
    } catch (e) {
      return NextResponse.json(
        { error: (e as Error).message },
        { status: 400 }
      );
    }
    const connections = await allRows<AdConnection>(
      'ads_connections',
      ctx.accountId
    );
    const connection = connections.find((c) => c.id === id) || connections[0];
    if (id && !connections.some((c) => c.id === id))
      return NextResponse.json(
        { error: 'Ad account not found in this workspace' },
        { status: 404 }
      );
    const [documents, events, changes, stages, flows, deals, attempts] =
      await Promise.all([
        allRows<{
          id: string;
          kind: string;
          name: string;
          data: Record<string, unknown>;
          revision: number;
        }>('ads_documents', ctx.accountId),
        db
          .from('ads_conversion_events')
          .select('*')
          .eq('account_id', ctx.accountId)
          .order('occurred_at', { ascending: false })
          .limit(200),
        db
          .from('ads_change_requests')
          .select('*')
          .eq('account_id', ctx.accountId)
          .order('created_at', { ascending: false })
          .limit(100),
        db.from('pipeline_stages').select('id,name,pipeline_id'),
        db
          .from('flows')
          .select('id,name')
          .eq('account_id', ctx.accountId)
          .eq('status', 'active'),
        scopedRows<{
          id: string;
          title: string;
          contact_id: string;
          value: number;
          currency: string;
          stage_id: string;
        }>(
          db,
          'deals',
          ctx.accountId,
          'id,title,contact_id,value,currency,stage_id'
        ),
        db
          .from('ads_conversion_attempts')
          .select('*')
          .eq('account_id', ctx.accountId)
          .order('created_at', { ascending: false })
          .limit(200),
      ]);
    documents.sort((a, b) =>
      String(
        (a as typeof a & { updated_at?: string }).updated_at || ''
      ).localeCompare(
        String((b as typeof b & { updated_at?: string }).updated_at || '')
      )
    );
    const { data: profile } = await db
      .from('profiles')
      .select('team_type')
      .eq('user_id', ctx.userId)
      .maybeSingle();
    const base = {
      connections,
      documents,
      events: events.data || [],
      attempts: attempts.data || [],
      changes: changes.data || [],
      stages: stages.data || [],
      flows: flows.data || [],
      deals,
      role: ctx.role,
      teamType: profile?.team_type || null,
    };
    if (!connection)
      return NextResponse.json({
        ...base,
        connection: null,
        report: null,
        entities: [],
        recommendations: [],
      });
    const [
      entities,
      insights,
      contacts,
      clicks,
      qualifications,
      sales,
      journeys,
    ] = await Promise.all([
      allRows<CampaignEntity>('ads_entities', ctx.accountId, {
        key: 'connection_id',
        value: connection.id,
      }),
      allRows<DailyInsight>('ads_daily_insights', ctx.accountId, {
        key: 'connection_id',
        value: connection.id,
      }),
      scopedRows<ReportContact>(
        db,
        'contacts',
        ctx.accountId,
        'id,name,ctwa_source_id,created_at'
      ),
      allRows<{
        contact_id: string | null;
        ad_id: string | null;
        occurred_at: string;
      }>('ctwa_click_events', ctx.accountId),
      allRows<Qualification>('ads_qualifications', ctx.accountId),
      allRows<Sale>('ads_sales', ctx.accountId),
      scopedRows<FlowJourney>(
        supabaseAdmin(),
        'flow_runs',
        ctx.accountId,
        'id,contact_id,flow_id,status,current_node_key,started_at,ended_at,follow_up_attempts'
      ),
    ]);
    const accountContacts = await scopedRows<ReportContact>(
      supabaseAdmin(),
      'contacts',
      ctx.accountId,
      'id,name,ctwa_source_id,created_at'
    );
    const accountConversations = await scopedRows<ConversationMilestone>(
      supabaseAdmin(),
      'conversations',
      ctx.accountId,
      'id,contact_id,ads_customer_messages,ads_first_customer_at,ads_first_human_at,ads_first_bot_at,last_message_sender_type,status'
    );
    const input = {
      connection,
      entities,
      insights,
      contacts: accountContacts,
      clicks,
      qualifications,
      sales,
      conversations: accountConversations,
      flows: journeys,
      start,
      end,
    };
    const report = campaignReport(input),
      comparison = campaignReport({ ...input, ...previous });
    // Workspace aggregates are shared, but lead drill-down follows the caller's CRM visibility.
    const visibleIds = new Set(contacts.map((c) => c.id));
    report.leads = report.leads.filter((c) => visibleIds.has(c.id));
    comparison.leads = comparison.leads.filter((c) => visibleIds.has(c.id));
    for (const result of [report, comparison]) {
      for (const stage of ['acquired', 'qualified', 'customers'] as const)
        result.journey[stage] = result.journey[stage].filter((id) =>
          visibleIds.has(id)
        );
      result.flowMetrics.dropOffs = result.flowMetrics.dropOffs.filter((f) =>
        visibleIds.has(f.contactId)
      );
      result.conversations.engagedContactIds =
        result.conversations.engagedContactIds.filter((id) =>
          visibleIds.has(id)
        );
      result.conversations.answeredContactIds =
        result.conversations.answeredContactIds.filter((id) =>
          visibleIds.has(id)
        );
    }
    return NextResponse.json({
      ...base,
      connection,
      entities,
      report,
      comparison,
      previous,
      sales,
      recommendations: campaignRecommendations(report, comparison),
      coverage: {
        start: connection.history_start,
        contactLimitReached: false,
        conversationLimitReached: false,
      },
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
const documentKinds = new Set([
  'draft',
  'creative',
  'view',
  'report',
  'experiment',
  'note',
  'rules',
  'decision',
]);
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object')
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
    const ctx = await requireRole(
        ['qualification', 'sale'].includes(body.action) ? 'agent' : 'admin'
      ),
      db = supabaseAdmin();
    if (
      ['qualification', 'sale'].includes(body.action) &&
      ctx.role === 'agent'
    ) {
      const { data: profile } = await db
        .from('profiles')
        .select('team_type')
        .eq('user_id', ctx.userId)
        .maybeSingle();
      if (profile?.team_type !== 'sales')
        throw new ForbiddenError(
          'Sales access is required to confirm outcomes'
        );
      const { data: visible } = await ctx.supabase
        .from('contacts')
        .select('id')
        .eq('id', body.contactId)
        .maybeSingle();
      if (!visible) throw new ForbiddenError('Contact is not assigned to you');
    }
    if (body.action === 'document') {
      if (
        !documentKinds.has(body.kind) ||
        typeof body.name !== 'string' ||
        !body.name.trim() ||
        !body.data ||
        Array.isArray(body.data) ||
        typeof body.data !== 'object' ||
        JSON.stringify(body.data).length > 100_000
      )
        return NextResponse.json(
          { error: 'Choose a document type, name and valid settings' },
          { status: 400 }
        );
      if (body.kind === 'rules') {
        if (
          typeof body.data.enabled !== 'boolean' ||
          !['all', 'any'].includes(body.data.match) ||
          !Array.isArray(body.data.qualifiedStages) ||
          !Array.isArray(body.data.saleStages)
        )
          return NextResponse.json(
            { error: 'Choose valid rule matching and pipeline stages' },
            { status: 400 }
          );
        // Rule changes apply prospectively; never bulk-publish historical qualifications.
        body.data.effectiveAt = new Date().toISOString();
        const rules = body.data.rules || [];
        if (
          !Array.isArray(rules) ||
          rules.length > 30 ||
          rules.some(
            (r: Record<string, unknown>) =>
              !['contact', 'answer', 'stage'].includes(String(r.source)) ||
              !['equals', 'contains', 'gte', 'exists'].includes(
                String(r.operator)
              ) ||
              typeof r.field !== 'string' ||
              typeof r.value !== 'string' ||
              (r.operator !== 'exists' && !String(r.value).trim()) ||
              (r.source !== 'stage' && !String(r.field).trim())
          )
        )
          return NextResponse.json(
            { error: 'Invalid qualification rules' },
            { status: 400 }
          );
        const ids = [
          ...(body.data.qualifiedStages || []),
          ...(body.data.saleStages || []),
        ];
        if (ids.length) {
          const { data: owned } = await ctx.supabase
            .from('pipeline_stages')
            .select('id')
            .in('id', ids);
          if (new Set(owned?.map((s) => s.id)).size !== new Set(ids).size)
            return NextResponse.json(
              { error: 'A selected stage is not in this workspace' },
              { status: 400 }
            );
        }
      }
      if (body.kind === 'draft' && body.id) {
        const { data: busy } = await db
          .from('ads_change_requests')
          .select('id')
          .eq('account_id', ctx.accountId)
          .eq('entity_id', body.id)
          .in('status', ['review', 'processing', 'uncertain'])
          .limit(1)
          .maybeSingle();
        if (busy)
          return NextResponse.json(
            {
              error:
                'Finish or resolve the current publish review before editing this draft',
            },
            { status: 409 }
          );
      }
      const record = {
        name: body.name.trim().slice(0, 200),
        data: body.data,
        updated_at: new Date().toISOString(),
      };
      const result = body.id
        ? await db
            .from('ads_documents')
            .update({ ...record, revision: Number(body.revision) + 1 })
            .eq('id', body.id)
            .eq('account_id', ctx.accountId)
            .eq('revision', body.revision)
            .eq('kind', body.kind)
            .select('*')
            .maybeSingle()
        : await db
            .from('ads_documents')
            .insert({
              ...record,
              account_id: ctx.accountId,
              kind: body.kind,
              created_by: ctx.userId,
            })
            .select('*')
            .single();
      if (result.error) throw result.error;
      if (!result.data)
        return NextResponse.json(
          { error: 'This record changed; reload before saving' },
          { status: 409 }
        );
      return NextResponse.json({ document: result.data });
    }
    if (body.action === 'qualification') {
      if (
        !['qualified', 'unqualified'].includes(body.status) ||
        typeof body.reason !== 'string' ||
        !body.reason.trim()
      )
        return NextResponse.json(
          { error: 'Choose a result and enter its reason' },
          { status: 400 }
        );
      const { data: contact } = await db
        .from('contacts')
        .select('id')
        .eq('id', body.contactId)
        .eq('account_id', ctx.accountId)
        .maybeSingle();
      if (!contact)
        return NextResponse.json(
          { error: 'Contact not found' },
          { status: 404 }
        );
      const { error } = await db.from('ads_qualifications').insert({
        account_id: ctx.accountId,
        contact_id: contact.id,
        status: body.status,
        reason: body.reason.slice(0, 1000),
        source: 'staff',
        actor_id: ctx.userId,
      });
      if (error) throw error;
      return NextResponse.json({ saved: true });
    }
    if (body.action === 'sale')
      return confirmSale(body, ctx.accountId, 'staff', ctx.userId);
    if (body.action === 'evaluate')
      return NextResponse.json(await evaluateWorkspaceRules(ctx.accountId));
    if (body.action === 'retry') {
      const { error } = await db
        .from('ads_conversion_events')
        .update({
          status: 'pending',
          attempt_count: 0,
          next_attempt_at: new Date().toISOString(),
          reason: 'Retry requested by administrator',
        })
        .eq('account_id', ctx.accountId)
        .eq('id', body.eventId)
        .in('status', ['failed', 'skipped']);
      if (error) throw error;
      return NextResponse.json({ queued: true });
    }
    if (body.action === 'integration-key') {
      const key = randomBytes(32).toString('hex');
      const { error } = await db.from('ads_integration_keys').upsert({
        account_id: ctx.accountId,
        secret_hash: createHash('sha256').update(key).digest('hex'),
      });
      if (error) throw error;
      return NextResponse.json({
        key,
        note: 'Save this key now. It is shown once. Rotation invalidates the previous key.',
      });
    }
    return NextResponse.json(
      { error: 'Unknown workspace action' },
      { status: 400 }
    );
  } catch (err) {
    return toErrorResponse(err);
  }
}
