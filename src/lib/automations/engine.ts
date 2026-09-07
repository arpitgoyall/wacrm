import type {
  Automation,
  AutomationLogStepResult,
  AutomationStep,
  AutomationTriggerType,
  ConditionStepConfig,
  KeywordMatchTriggerConfig,
  InteractiveReplyTriggerConfig,
  TagTriggerConfig,
  SendMessageStepConfig,
  SendButtonsStepConfig,
  SendListStepConfig,
  SendTemplateStepConfig,
  SendWebhookStepConfig,
  TagStepConfig,
  UpdateContactFieldStepConfig,
  WaitStepConfig,
  CreateDealStepConfig,
  AssignDealStepConfig,
  AssignConversationStepConfig,
  DealStageChangedTriggerConfig,
  SendMetaCapiEventStepConfig,
} from '@/types'
import { supabaseAdmin } from './admin-client'
import { addContactTagIfAbsent } from '@/lib/contacts/tag-write'
import { MAX_TAG_CHAIN_DEPTH, getTagChainDepth } from '@/lib/contacts/tag-chain'
import { engineSendText, engineSendTemplate, engineSendInteractive } from './meta-send'
import { validateInteractivePayload } from '@/lib/whatsapp/interactive'
import { isDeliverableUrl } from '@/lib/webhooks/ssrf'
import { sendCtwaConversion } from './ctwa-capi'
import { decrypt } from '@/lib/whatsapp/encryption'

// ------------------------------------------------------------
// Public API
// ------------------------------------------------------------

export interface AutomationContext {
  /** Raw message text, for keyword_match + message_content conditions. */
  message_text?: string
  /** Conversation the event belongs to, if any. */
  conversation_id?: string
  /** Arbitrary variables accumulated during execution. */
  vars?: Record<string, unknown>
  /** The tag id that was added, for tag_added trigger. */
  tag_id?: string
  /** Agent the conversation was assigned to, for conversation_assigned. */
  agent_id?: string
  /** Button / list-row id the customer tapped, for interactive_reply. */
  interactive_reply_id?: string
  /**
   * Deal-stage-change fields, set by the deal-stage-events cron for the
   * `deal_stage_changed` trigger. `deal_to_stage_id` is what
   * `triggerMatches` compares; the rest feed the `send_meta_capi_event`
   * step and `{{ deal.* }}` interpolation.
   */
  deal_id?: string
  deal_pipeline_id?: string
  deal_from_stage_id?: string
  deal_to_stage_id?: string
  /** Deal columns snapshotted by the cron, for `{{ deal.* }}` + the CAPI step. */
  deal_value?: number
  deal_currency?: string
  deal_title?: string
}

export interface DispatchInput {
  /** Account-level tenancy key. Drives the lookup of which active
   *  automations to fire — `automations.account_id` is the tenant
   *  isolation after migration 017. Replaces the previous `userId`
   *  field; the per-automation user_id is read off each row when
   *  needed (sender identity for outbound messages, log audit). */
  accountId: string
  triggerType: AutomationTriggerType
  contactId?: string | null
  context?: AutomationContext
}

/**
 * Fire all active automations matching the given trigger for an
 * account.
 *
 * Must never throw — callers use fire-and-forget from the webhook.
 * All errors are caught and logged; per-automation failures are
 * recorded into automation_logs with status='failed'.
 */
export async function runAutomationsForTrigger(input: DispatchInput): Promise<void> {
  try {
    const db = supabaseAdmin()

    // Tenant isolation. `contactId` can be caller-supplied (the manual
    // POST /api/automations/engine entrypoint reads it straight from the
    // request body), and every step below runs through the service-role
    // client, which bypasses RLS. So before any step can touch the
    // contact, verify it actually belongs to this account. A foreign or
    // forged id is refused silently — callers are fire-and-forget, and a
    // distinct error would leak whether a given contact UUID exists.
    if (input.contactId) {
      const { data: owned, error: ownErr } = await db
        .from('contacts')
        .select('id')
        .eq('id', input.contactId)
        .eq('account_id', input.accountId)
        .maybeSingle()
      if (ownErr) {
        console.error('[automations] contact ownership check failed:', ownErr)
        return
      }
      if (!owned) {
        console.warn('[automations] contact not in account, refusing dispatch', input.contactId)
        return
      }
    }

    const { data: automations, error } = await db
      .from('automations')
      .select('*')
      .eq('account_id', input.accountId)
      .eq('trigger_type', input.triggerType)
      .eq('is_active', true)

    if (error) {
      console.error('[automations] fetch failed:', error)
      return
    }
    if (!automations || automations.length === 0) return

    for (const automation of automations as Automation[]) {
      if (!triggerMatches(automation, input.context)) continue
      try {
        await executeAutomation(automation, input)
      } catch (err) {
        console.error('[automations] execute failed:', automation.id, err)
      }
    }
  } catch (err) {
    console.error('[automations] dispatch failed:', err)
  }
}

/**
 * Run ONE automation by id for a contact, bypassing trigger matching —
 * the caller has already decided it should fire (a CTWA ad → automation
 * binding, migration 055). Ownership-checked like
 * `runAutomationsForTrigger`; never throws.
 */
export async function runAutomationById(input: {
  automationId: string
  accountId: string
  contactId?: string | null
  context?: AutomationContext
}): Promise<void> {
  try {
    const db = supabaseAdmin()

    if (input.contactId) {
      const { data: owned, error: ownErr } = await db
        .from('contacts')
        .select('id')
        .eq('id', input.contactId)
        .eq('account_id', input.accountId)
        .maybeSingle()
      if (ownErr) {
        console.error('[automations] runById ownership check failed:', ownErr)
        return
      }
      if (!owned) {
        console.warn('[automations] runById: contact not in account', input.contactId)
        return
      }
    }

    const { data: automation, error } = await db
      .from('automations')
      .select('*')
      .eq('id', input.automationId)
      .eq('account_id', input.accountId)
      .eq('is_active', true)
      .maybeSingle()
    if (error) {
      console.error('[automations] runById fetch failed:', error)
      return
    }
    if (!automation) return

    await executeAutomation(automation as Automation, {
      accountId: input.accountId,
      // Not a real trigger — the binding is. Stored verbatim in
      // automation_logs.trigger_event (a free-text column).
      triggerType: 'ad_binding' as AutomationTriggerType,
      contactId: input.contactId ?? null,
      context: input.context,
    })
  } catch (err) {
    console.error('[automations] runAutomationById failed:', err)
  }
}

/**
 * Resume a run that was parked at a wait step. Called from the cron
 * endpoint after it grabs a due `automation_pending_executions` row.
 */
export async function resumePendingExecution(pending: {
  id: string
  automation_id: string
  /** Audit-only; the automation row carries account_id for tenancy. */
  user_id: string
  /** Account-scoped lookups read from the automation row, so this
   *  field is just here to mirror the row shape and keep the cron's
   *  pass-through self-documenting. */
  account_id: string
  contact_id: string | null
  log_id: string | null
  parent_step_id: string | null
  branch: 'yes' | 'no' | null
  next_step_position: number
  context: AutomationContext
}): Promise<void> {
  const db = supabaseAdmin()
  const { data: automation, error } = await db
    .from('automations')
    .select('*')
    .eq('id', pending.automation_id)
    .single()

  if (error || !automation) {
    console.error('[automations] resume: missing automation', pending.automation_id, error)
    await markPending(pending.id, 'failed')
    return
  }

  try {
    await executeStepsFrom({
      automation: automation as Automation,
      contactId: pending.contact_id,
      context: pending.context ?? {},
      parentStepId: pending.parent_step_id,
      branch: pending.branch,
      startPosition: pending.next_step_position,
      logId: pending.log_id,
      triggerEvent: 'resumed_wait',
    })
    await markPending(pending.id, 'done')
  } catch (err) {
    console.error('[automations] resume failed:', err)
    await markPending(pending.id, 'failed')
  }
}

// ------------------------------------------------------------
// Internal execution
// ------------------------------------------------------------

async function executeAutomation(automation: Automation, input: DispatchInput) {
  const db = supabaseAdmin()

  const { data: log, error: logErr } = await db
    .from('automation_logs')
    .insert({
      automation_id: automation.id,
      // Tenancy: matches automation.account_id (NOT NULL post-017).
      account_id: automation.account_id,
      // Audit: keeps the historical "author of this automation"
      // pointer so logs still attribute to the right user even
      // after teammates join the account.
      user_id: automation.user_id,
      contact_id: input.contactId ?? null,
      trigger_event: input.triggerType,
      steps_executed: [],
      // Seeded pessimistically. The row is written BEFORE any step runs,
      // and every terminal path below overwrites it (`appendResults` at
      // the outermost scope, or `finalizeLog`). Seeding 'success' meant a
      // run that died mid-flight — the process frozen, the pod recycled —
      // left a permanent `status: 'success'` with `steps_executed: []`,
      // indistinguishable from an automation that genuinely had nothing
      // to do. 'failed' inverts that: the status only becomes success if
      // execution actually reached the end. See issue #409.
      status: 'failed',
    })
    .select()
    .single()

  if (logErr || !log) {
    console.error('[automations] cannot create log:', logErr)
    return
  }

  await executeStepsFrom({
    automation,
    contactId: input.contactId ?? null,
    context: input.context ?? {},
    parentStepId: null,
    branch: null,
    startPosition: 0,
    logId: log.id,
    triggerEvent: input.triggerType,
  })

  // Atomic counter update via the SQL function from migration 007.
  // Doing this with a client-side read-modify-write raced when the
  // same automation fired for two contacts simultaneously — both
  // would read N and both write N+1, losing one count permanently.
  const { error: rpcErr } = await db.rpc('increment_automation_execution_count', {
    p_automation_id: automation.id,
  })
  if (rpcErr) {
    console.error('[automations] increment counter failed:', rpcErr)
  }
}

interface ExecuteArgs {
  automation: Automation
  contactId: string | null
  context: AutomationContext
  parentStepId: string | null
  branch: 'yes' | 'no' | null
  startPosition: number
  logId: string | null
  triggerEvent: string
}

async function executeStepsFrom(args: ExecuteArgs): Promise<void> {
  const db = supabaseAdmin()

  const baseQuery = db
    .from('automation_steps')
    .select('*')
    .eq('automation_id', args.automation.id)
    .gte('position', args.startPosition)
    .order('position', { ascending: true })

  const scoped =
    args.parentStepId === null
      ? baseQuery.is('parent_step_id', null)
      : baseQuery.eq('parent_step_id', args.parentStepId).eq('branch', args.branch ?? 'yes')

  const { data: steps, error: stepsErr } = await scoped

  if (stepsErr) {
    await finalizeLog(args.logId, 'failed', stepsErr.message)
    return
  }
  if (!steps || steps.length === 0) {
    if (args.parentStepId === null && args.logId) {
      await finalizeLog(args.logId, 'success', null)
    }
    return
  }

  const results: AutomationLogStepResult[] = []
  let status: 'success' | 'partial' | 'failed' = 'success'
  let errorMessage: string | null = null

  for (const step of steps as AutomationStep[]) {
    // `wait` is the suspension point: enqueue and stop processing this
    // scope. The cron endpoint will pick it up later.
    if (step.step_type === 'wait') {
      const cfg = step.step_config as WaitStepConfig
      const ms = waitMs(cfg)
      await db.from('automation_pending_executions').insert({
        automation_id: args.automation.id,
        // Tenancy: account_id required NOT NULL post-017.
        account_id: args.automation.account_id,
        user_id: args.automation.user_id,
        contact_id: args.contactId,
        log_id: args.logId,
        parent_step_id: args.parentStepId,
        branch: args.branch,
        next_step_position: step.position + 1,
        context: args.context,
        run_at: new Date(Date.now() + ms).toISOString(),
        status: 'pending',
      })
      results.push({
        step_id: step.id,
        step_type: step.step_type,
        status: 'success',
        detail: `waiting ${cfg.amount} ${cfg.unit}`,
      })
      status = 'partial'
      await appendResults(args.logId, results, status, errorMessage)
      return
    }

    try {
      if (step.step_type === 'condition') {
        const cfg = step.step_config as ConditionStepConfig
        const taken = await evaluateCondition(cfg, args)
        results.push({
          step_id: step.id,
          step_type: 'condition',
          status: 'success',
          detail: `branch=${taken ? 'yes' : 'no'}`,
        })
        // Recurse into the chosen branch at position 0 (children use their
        // own ordering within the branch scope).
        await executeStepsFrom({
          ...args,
          parentStepId: step.id,
          branch: taken ? 'yes' : 'no',
          startPosition: 0,
          logId: args.logId,
        })
        continue
      }

      const detail = await runStep(step, args)
      results.push({
        step_id: step.id,
        step_type: step.step_type,
        status: 'success',
        detail,
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      results.push({
        step_id: step.id,
        step_type: step.step_type,
        status: 'failed',
        detail: msg,
      })
      status = 'failed'
      errorMessage = msg
      break
    }
  }

  if (args.parentStepId === null) {
    await appendResults(args.logId, results, status, errorMessage)
  } else {
    // Nested branch — just append results; parent scope decides final status.
    await appendResults(args.logId, results, null, errorMessage)
  }
}

async function runStep(step: AutomationStep, args: ExecuteArgs): Promise<string> {
  const db = supabaseAdmin()

  switch (step.step_type) {
    case 'send_message': {
      const cfg = step.step_config as SendMessageStepConfig
      if (!args.contactId) throw new Error('send_message needs a contact')
      const text = interpolate(cfg.text, args)
      if (!text.trim()) throw new Error('send_message has empty text')
      const conversationId = await resolveConversationId(args)
      const { whatsapp_message_id } = await engineSendText({
        accountId: args.automation.account_id,
        userId: args.automation.user_id,
        conversationId,
        contactId: args.contactId,
        text,
      })
      return `sent via Meta (${whatsapp_message_id})`
    }

    case 'send_buttons':
    case 'send_list': {
      const payload = step.step_config as SendButtonsStepConfig | SendListStepConfig
      if (!args.contactId) throw new Error(`${step.step_type} needs a contact`)
      // Validate against Meta's limits before the network call so a bad
      // payload surfaces as a clear failed-step detail rather than a raw
      // Meta 400 mid-conversation.
      const check = validateInteractivePayload(payload)
      if (!check.ok) throw new Error(check.error)
      const conversationId = await resolveConversationId(args)
      const { whatsapp_message_id } = await engineSendInteractive({
        accountId: args.automation.account_id,
        userId: args.automation.user_id,
        conversationId,
        contactId: args.contactId,
        payload,
      })
      return `interactive sent via Meta (${whatsapp_message_id})`
    }

    case 'send_template': {
      const cfg = step.step_config as SendTemplateStepConfig
      if (!args.contactId) throw new Error('send_template needs a contact')
      if (!cfg.template_name) throw new Error('send_template needs template_name')
      const conversationId = await resolveConversationId(args)
      // Meta templates use positional {{1}}, {{2}}, … placeholders, so
      // we MUST emit params in strict numeric order. Lexicographic sort
      // of "1", "2", …, "10" yields "1", "10", "2", … which silently
      // scrambles every template with ≥10 variables.
      const params = cfg.variables
        ? Object.keys(cfg.variables)
            .sort((a, b) => {
              const na = Number(a)
              const nb = Number(b)
              const aNum = Number.isFinite(na)
              const bNum = Number.isFinite(nb)
              if (aNum && bNum) return na - nb
              if (aNum) return -1
              if (bNum) return 1
              return a.localeCompare(b)
            })
            .map((k) => String(cfg.variables![k]))
        : []
      const { whatsapp_message_id } = await engineSendTemplate({
        accountId: args.automation.account_id,
        userId: args.automation.user_id,
        conversationId,
        contactId: args.contactId,
        templateName: cfg.template_name,
        language: cfg.language,
        params,
      })
      return `template sent via Meta (${whatsapp_message_id})`
    }

    case 'add_tag': {
      const cfg = step.step_config as TagStepConfig
      if (!args.contactId || !cfg.tag_id) throw new Error('add_tag needs contact + tag_id')
      const added = await addContactTagIfAbsent(db, {
        accountId: args.automation.account_id,
        contactId: args.contactId,
        tagId: cfg.tag_id,
      })
      if (!added) return `tag ${cfg.tag_id} already present`

      const depth = getTagChainDepth(args.context)
      if (depth >= MAX_TAG_CHAIN_DEPTH) {
        console.warn('[automations] tag_added chain depth limit reached', {
          automationId: args.automation.id,
          contactId: args.contactId,
          tagId: cfg.tag_id,
          depth,
        })
        return `tag ${cfg.tag_id} added; tag_added dispatch skipped at depth ${depth}`
      }

      await runAutomationsForTrigger({
        accountId: args.automation.account_id,
        triggerType: 'tag_added',
        contactId: args.contactId,
        context: {
          ...args.context,
          tag_id: cfg.tag_id,
          vars: {
            ...(args.context.vars ?? {}),
            _tag_chain_depth: depth + 1,
          },
        },
      })
      return `tag ${cfg.tag_id} added and tag_added dispatched`
    }

    case 'remove_tag': {
      // See add_tag: tenant scoping relies on the runAutomationsForTrigger
      // ownership guard, since contact_tags carries no account_id.
      const cfg = step.step_config as TagStepConfig
      if (!args.contactId || !cfg.tag_id) throw new Error('remove_tag needs contact + tag_id')
      await db
        .from('contact_tags')
        .delete()
        .eq('contact_id', args.contactId)
        .eq('tag_id', cfg.tag_id)
      return `tag ${cfg.tag_id} removed`
    }

    case 'assign_conversation': {
      const cfg = step.step_config as AssignConversationStepConfig
      if (!args.contactId) throw new Error('assign_conversation needs a contact')
      const agentId = await resolveAssignmentAgent(args, cfg)
      if (!agentId) return 'no agent resolved'
      await db
        .from('conversations')
        .update({ assigned_agent_id: agentId })
        .eq('account_id', args.automation.account_id)
        .eq('contact_id', args.contactId)
      return `assigned to ${agentId}`
    }

    case 'update_contact_field': {
      const cfg = step.step_config as UpdateContactFieldStepConfig
      if (!args.contactId) throw new Error('update_contact_field needs a contact')
      // Resolve workflow variables ({{ vars.* }}, {{ message.text }}) so custom
      // values can be populated dynamically from the triggering context.
      const value = interpolate(cfg.value, args)

      // Custom fields are encoded as `custom:<custom_field_id>`; anything else
      // is a built-in contact column.
      if (cfg.field.startsWith('custom:')) {
        const customFieldId = cfg.field.slice('custom:'.length)
        if (!customFieldId) {
          return `field ${cfg.field} not writable from automations`
        }
        // Defense in depth: the service-role client bypasses RLS, so confirm
        // the field definition belongs to this account before writing.
        const { data: field } = await db
          .from('custom_fields')
          .select('id')
          .eq('id', customFieldId)
          .eq('account_id', args.automation.account_id)
          .maybeSingle()
        if (!field) {
          return `field ${cfg.field} not writable from automations`
        }
        // Upsert on the table's UNIQUE(contact_id, custom_field_id) so repeated
        // runs overwrite rather than duplicate. Tenancy is enforced above and,
        // for the contact side, by the entry-point ownership guard.
        await db
          .from('contact_custom_values')
          .upsert(
            { contact_id: args.contactId, custom_field_id: customFieldId, value },
            { onConflict: 'contact_id,custom_field_id' },
          )
        return `custom field updated`
      }

      const allowed = new Set(['name', 'email', 'company'])
      if (!allowed.has(cfg.field)) {
        return `field ${cfg.field} not writable from automations`
      }
      // Defense in depth: scope the service-role write to the account so
      // a future caller that skips the entry-point ownership guard still
      // cannot write across tenants.
      await db
        .from('contacts')
        .update({ [cfg.field]: value, updated_at: new Date().toISOString() })
        .eq('id', args.contactId)
        .eq('account_id', args.automation.account_id)
      return `${cfg.field} updated`
    }

    case 'create_deal': {
      const cfg = step.step_config as CreateDealStepConfig
      if (!cfg.pipeline_id || !cfg.stage_id) throw new Error('create_deal needs pipeline + stage')
      // Match the account's configured default currency rather than
      // the static `deals.currency` DB default — keeps automation-
      // created deals consistent with the one-currency-per-account
      // rule (issue #218). Fall back to USD if the row is somehow
      // missing the value (pre-021 forks).
      const { data: acct } = await db
        .from('accounts')
        .select('default_currency')
        .eq('id', args.automation.account_id)
        .maybeSingle()
      // Snapshot the contact's CTWA attribution onto the deal so a
      // later `send_meta_capi_event` step attributes THIS deal even if
      // the contact clicks a different ad in between. The CAPI step
      // still falls back to the contact's own columns for deals created
      // outside automations.
      let dealCtwaClid: string | null = null
      let dealCtwaSourceId: string | null = null
      if (args.contactId) {
        const { data: ctwaContact } = await db
          .from('contacts')
          .select('ctwa_clid, ctwa_source_id')
          .eq('id', args.contactId)
          .eq('account_id', args.automation.account_id)
          .maybeSingle()
        dealCtwaClid = (ctwaContact as { ctwa_clid: string | null } | null)?.ctwa_clid ?? null
        dealCtwaSourceId =
          (ctwaContact as { ctwa_source_id: string | null } | null)?.ctwa_source_id ?? null
      }
      await db.from('deals').insert({
        // Tenancy + audit, same split as automation_logs above.
        account_id: args.automation.account_id,
        user_id: args.automation.user_id,
        pipeline_id: cfg.pipeline_id,
        stage_id: cfg.stage_id,
        contact_id: args.contactId,
        title: interpolate(cfg.title, args),
        value: cfg.value ?? 0,
        currency: acct?.default_currency ?? 'USD',
        status: 'open',
        ctwa_clid: dealCtwaClid,
        ctwa_source_id: dealCtwaSourceId,
      })
      return 'deal created'
    }

    case 'assign_deal': {
      const cfg = step.step_config as AssignDealStepConfig
      if (!args.contactId) throw new Error('assign_deal needs a contact')
      const agentId = await resolveAssignmentAgent(args, cfg)
      if (!agentId) return 'no agent resolved'
      let dealQuery = db
        .from('deals')
        .select('id')
        .eq('account_id', args.automation.account_id)
        .eq('contact_id', args.contactId)
        // Only route open work. Without this, a contact whose most recent
        // deal happens to already be won/lost (e.g. re-imported or
        // backfilled data) would get that stale deal reassigned instead
        // of an older still-open one, silently doing nothing useful.
        .eq('status', 'open')
        .order('created_at', { ascending: false })
        .limit(1)
      if (cfg.pipeline_id) dealQuery = dealQuery.eq('pipeline_id', cfg.pipeline_id)
      if (cfg.stage_id) dealQuery = dealQuery.eq('stage_id', cfg.stage_id)
      const { data: deals } = await dealQuery
      const dealId = deals?.[0]?.id
      if (!dealId) return 'no deal resolved'
      // deals.assigned_to is a FK to profiles.id, but resolveAssignmentAgent
      // resolves to the agent's auth user_id (shared with assign_conversation,
      // whose assigned_agent_id column IS keyed by user_id) — translate here.
      const { data: profile } = await db
        .from('profiles')
        .select('id')
        .eq('account_id', args.automation.account_id)
        .eq('user_id', agentId)
        .maybeSingle()
      if (!profile) return 'no agent profile resolved'
      const { error: assignError } = await db
        .from('deals')
        .update({ assigned_to: profile.id })
        .eq('id', dealId)
      if (assignError) throw new Error(`assign_deal: ${assignError.message}`)
      return `deal ${dealId} assigned to ${profile.id}`
    }

    case 'send_meta_capi_event': {
      const cfg = step.step_config as SendMetaCapiEventStepConfig
      const eventName = (cfg.event_name ?? '').trim()
      if (!eventName) throw new Error('send_meta_capi_event needs an event_name')

      // This step is meaningful only for the deal_stage_changed trigger,
      // which puts the deal id on the context.
      const dealId = args.context.deal_id
      const stageId = args.context.deal_to_stage_id
      if (!dealId || !stageId) {
        return 'skipped: no deal in context (not a deal_stage_changed run)'
      }

      // Deal + its contact's stored CTWA click id. Prefer the deal's own
      // snapshot (taken at creation), fall back to the contact.
      const { data: deal } = await db
        .from('deals')
        .select('id, contact_id, value, currency, ctwa_clid')
        .eq('id', dealId)
        .eq('account_id', args.automation.account_id)
        .maybeSingle()
      if (!deal) return 'skipped: deal not found'

      let ctwaClid = (deal as { ctwa_clid: string | null }).ctwa_clid ?? null
      if (!ctwaClid && deal.contact_id) {
        const { data: contact } = await db
          .from('contacts')
          .select('ctwa_clid')
          .eq('id', deal.contact_id)
          .eq('account_id', args.automation.account_id)
          .maybeSingle()
        ctwaClid = (contact as { ctwa_clid: string | null } | null)?.ctwa_clid ?? null
      }
      if (!ctwaClid) {
        return 'skipped: contact has no ctwa_clid (deal not from a CTWA ad)'
      }

      // Conversions API credentials live on the account's whatsapp_config.
      const { data: waCfg } = await db
        .from('whatsapp_config')
        .select('waba_id, ctwa_dataset_id, ctwa_capi_token')
        .eq('account_id', args.automation.account_id)
        .maybeSingle()
      const datasetId = (waCfg as { ctwa_dataset_id: string | null } | null)?.ctwa_dataset_id
      const encryptedCapiToken = (waCfg as { ctwa_capi_token: string | null } | null)?.ctwa_capi_token
      const wabaId = (waCfg as { waba_id: string | null } | null)?.waba_id
      if (!datasetId || !encryptedCapiToken || !wabaId) {
        return 'skipped: account has no Conversions API config (dataset id / token / WABA id)'
      }
      // Token is stored encrypted, like access_token. A decrypt failure
      // (ENCRYPTION_KEY changed) is a real misconfig, not a silent skip.
      let capiToken: string
      try {
        capiToken = decrypt(encryptedCapiToken)
      } catch {
        throw new Error(
          'send_meta_capi_event: stored Conversions API token cannot be decrypted (ENCRYPTION_KEY mismatch)',
        )
      }

      // Idempotency: one conversion per (deal, stage, event). The unique
      // index makes the INSERT the lock — a duplicate raises 23505.
      const { error: guardErr } = await db.from('ctwa_conversion_dispatches').insert({
        account_id: args.automation.account_id,
        deal_id: dealId,
        stage_id: stageId,
        event_name: eventName,
        automation_id: args.automation.id,
        ctwa_clid: ctwaClid,
      })
      if (guardErr) {
        const msg = guardErr.message ?? ''
        if (msg.includes('23505') || msg.includes('duplicate key')) {
          return 'skipped: conversion already sent for this deal + stage'
        }
        throw new Error(`send_meta_capi_event guard insert failed: ${msg}`)
      }

      const rawValue = cfg.value ? interpolate(cfg.value, args).trim() : ''
      const parsedValue = rawValue ? Number(rawValue) : Number(deal.value ?? 0)
      const currency =
        (cfg.currency ? interpolate(cfg.currency, args).trim() : '') ||
        (deal.currency as string | null) ||
        'USD'

      const result = await sendCtwaConversion({
        datasetId,
        accessToken: capiToken,
        wabaId,
        ctwaClid,
        eventName,
        eventId: `${dealId}:${stageId}:${eventName}`,
        value: Number.isNaN(parsedValue) ? undefined : parsedValue,
        currency,
        partnerAgent: 'wacrm',
      })

      // Roll back the guard on failure so moving the deal through the
      // stage again can retry; keep it (with the status) on success.
      if (!result.ok) {
        await db
          .from('ctwa_conversion_dispatches')
          .delete()
          .eq('account_id', args.automation.account_id)
          .eq('deal_id', dealId)
          .eq('stage_id', stageId)
          .eq('event_name', eventName)
        throw new Error(
          `Meta Conversions API returned ${result.status}: ${JSON.stringify(result.body).slice(0, 300)}`,
        )
      }
      await db
        .from('ctwa_conversion_dispatches')
        .update({ response_status: result.status })
        .eq('account_id', args.automation.account_id)
        .eq('deal_id', dealId)
        .eq('stage_id', stageId)
        .eq('event_name', eventName)

      return `sent ${eventName} to Meta CAPI (${result.status})`
    }

    case 'send_webhook': {
      const cfg = step.step_config as SendWebhookStepConfig
      if (!cfg.url) throw new Error('send_webhook needs url')
      // SSRF guard: the URL and headers are account-controlled and the
      // server makes the request, so refuse any destination that resolves
      // to a private / loopback / link-local / reserved address. Mirrors
      // the webhook_endpoints delivery path (see lib/webhooks/deliver.ts).
      if (!(await isDeliverableUrl(cfg.url))) {
        throw new Error('send_webhook: destination not allowed')
      }
      const body = cfg.body_template ? interpolate(cfg.body_template, args) : JSON.stringify(args.context)
      const res = await fetch(cfg.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(cfg.headers ?? {}) },
        body,
        // Do NOT follow redirects — a public URL could 3xx-bounce to an
        // internal address, defeating the guard above. Bound the request
        // so a hung/slow internal host can't tie up the runner.
        redirect: 'manual',
        signal: AbortSignal.timeout(10_000),
      })
      if (!res.ok) throw new Error(`webhook returned ${res.status}`)
      return `webhook ${res.status}`
    }

    case 'close_conversation': {
      if (!args.contactId) throw new Error('close_conversation needs a contact')
      await db
        .from('conversations')
        .update({ status: 'closed', updated_at: new Date().toISOString() })
        .eq('account_id', args.automation.account_id)
        .eq('contact_id', args.contactId)
      return 'conversation closed'
    }

    default:
      return `unknown step: ${step.step_type}`
  }
}

const SHARED_ASSIGNMENT_KEY = '_automation_assigned_agent_id'

async function resolveAssignmentAgent(
  args: ExecuteArgs,
  cfg: AssignConversationStepConfig | AssignDealStepConfig,
): Promise<string | undefined> {
  if (cfg.mode === 'specific') return cfg.agent_id

  // Route to whoever currently owns the contact's conversation.
  // `conversations.assigned_agent_id` is keyed by auth user_id — the same
  // shape this function returns for the other modes (the assign_deal /
  // assign_conversation callers translate to profiles.id where needed).
  if (cfg.mode === 'conversation_owner') {
    let convQuery = supabaseAdmin()
      .from('conversations')
      .select('assigned_agent_id')
      .eq('account_id', args.automation.account_id)
    convQuery = args.context.conversation_id
      ? convQuery.eq('id', args.context.conversation_id)
      : convQuery.eq('contact_id', args.contactId ?? '')
    const { data: conv } = await convQuery.maybeSingle()
    return (
      (conv as { assigned_agent_id: string | null } | null)?.assigned_agent_id ??
      undefined
    )
  }

  // Cache round-robin results per agent pool, not globally per execution —
  // two round_robin steps in the same run with different agent_ids pools
  // must resolve independently. Steps sharing a pool (including the "any
  // agent" pool when agent_ids is empty) still resolve to the same agent,
  // which is the point of sharing the cache at all. Namespaced by
  // automation id so a chained run (e.g. tag_added dispatched from
  // add_tag, which inherits the parent's context.vars wholesale) never
  // reuses a sibling automation's pick just because its pool looks the same.
  const poolKey =
    Array.isArray(cfg.agent_ids) && cfg.agent_ids.length > 0
      ? [...cfg.agent_ids].sort().join(',')
      : '*'
  const cacheKey = `${SHARED_ASSIGNMENT_KEY}:${args.automation.id}:${poolKey}`

  const cached = args.context.vars?.[cacheKey]
  if (typeof cached === 'string' && cached) return cached

  let profileQuery = supabaseAdmin()
    .from('profiles')
    .select('user_id')
    .eq('account_id', args.automation.account_id)
    .eq('account_role', 'agent')
    .order('created_at', { ascending: true })
  if (Array.isArray(cfg.agent_ids) && cfg.agent_ids.length > 0) {
    profileQuery = profileQuery.in('user_id', cfg.agent_ids)
  }
  const { data: profiles } = await profileQuery
  if (!profiles || profiles.length === 0) return undefined

  // Atomic per-(automation, pool) cursor (migration 047) — automation.
  // execution_count is read once at dispatch and only incremented after
  // all steps finish (migration 007), so two concurrent runs of the same
  // automation would otherwise read the same stale count and land on the
  // same agent instead of rotating.
  const { data: index, error: idxErr } = await supabaseAdmin().rpc('next_round_robin_index', {
    p_automation_id: args.automation.id,
    p_pool_key: poolKey,
    p_pool_size: profiles.length,
  })
  if (idxErr || typeof index !== 'number') {
    console.error('[automations] round-robin cursor failed:', idxErr)
    return undefined
  }

  const agentId = profiles[index % profiles.length]?.user_id
  if (!agentId) return undefined

  args.context.vars = {
    ...(args.context.vars ?? {}),
    [cacheKey]: agentId,
  }
  return agentId
}

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------

/**
 * Pick the conversation a send-type step should use. Prefer the id the
 * webhook handed us (it's the one that just got the inbound message);
 * fall back to the contact's conversation for resumed/wait paths and
 * manual engine POSTs. Throws if none exists — send steps have
 * no meaningful target without a conversation.
 */
async function resolveConversationId(args: ExecuteArgs): Promise<string> {
  const fromCtx = args.context.conversation_id
  if (fromCtx) return fromCtx
  if (!args.contactId) throw new Error('cannot resolve conversation: no contact')
  const { data, error } = await supabaseAdmin()
    .from('conversations')
    .select('id')
    .eq('account_id', args.automation.account_id)
    .eq('contact_id', args.contactId)
    .maybeSingle()
  if (error) throw new Error(`conversation lookup failed: ${error.message}`)
  if (!data?.id) {
    const prefix = args.triggerEvent === 'tag_added'
      ? 'tag_added automation cannot send'
      : 'cannot send'
    throw new Error(`${prefix}: contact has no existing conversation`)
  }
  return data.id as string
}

/** Letter, digit or underscore in any script — the "inside a word" test. */
const WORD_CHAR = '[\\p{L}\\p{N}_]'

/**
 * Whole-word keyword test, behind `match_type: 'word'` (issue #409 — a
 * one-letter keyword under `contains` fires on every message containing
 * that letter, e.g. "k" on "thanks").
 *
 * Deliberately NOT `\b`, which is defined against `[A-Za-z0-9_]` and so
 * breaks two cases that matter for WhatsApp traffic:
 *
 *   - A keyword carrying punctuation: `/\bhi!\b/` demands a word character
 *     after the "!", so it never matches "say hi!".
 *   - Any non-Latin script: every character of "안녕" is a non-word
 *     character to `\b`, so `/\b안녕\b/` matches nothing at all.
 *
 * Unicode-aware lookarounds handle both. Note this really is word-based:
 * it won't find "안녕" inside "안녕하세요", because a language that doesn't
 * delimit words with spaces has no word edge there. That's what `contains`
 * is for, and it stays the default.
 *
 * Exported for direct unit testing of the escaping / boundary edges.
 */
export function matchesWholeWord(
  text: string,
  keyword: string,
  caseSensitive = false,
): boolean {
  if (!keyword) return false
  // The keyword is account-supplied free text, so metacharacters have to
  // be literal — otherwise "(" is an unterminated group and RegExp throws.
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(
    `(?<!${WORD_CHAR})${escaped}(?!${WORD_CHAR})`,
    caseSensitive ? 'u' : 'iu',
  )
  return pattern.test(text)
}

export function triggerMatches(automation: Automation, ctx: AutomationContext | undefined): boolean {
  if (automation.trigger_type === 'keyword_match') {
    const cfg = automation.trigger_config as KeywordMatchTriggerConfig
    if (!cfg?.keywords || cfg.keywords.length === 0) return false
    const text = (ctx?.message_text ?? '').toString()
    if (!text) return false
    if (cfg.match_type === 'word') {
      return cfg.keywords.some((raw) =>
        matchesWholeWord(text, raw, cfg.case_sensitive),
      )
    }
    const haystack = cfg.case_sensitive ? text : text.toLowerCase()
    return cfg.keywords.some((raw) => {
      const k = cfg.case_sensitive ? raw : raw.toLowerCase()
      return cfg.match_type === 'exact' ? haystack === k : haystack.includes(k)
    })
  }

  // Match on the tapped button / list-row id (exact). Lets multi-step
  // menus be chained: automation A sends buttons, automation B fires on
  // the reply id and sends the next step.
  if (automation.trigger_type === 'interactive_reply') {
    const cfg = automation.trigger_config as InteractiveReplyTriggerConfig
    const replyId = ctx?.interactive_reply_id
    if (!replyId || !Array.isArray(cfg?.reply_ids) || cfg.reply_ids.length === 0) {
      return false
    }
    return cfg.reply_ids.includes(replyId)
  }

  if (automation.trigger_type === 'tag_added') {
    const cfg = automation.trigger_config as TagTriggerConfig
    const tagId = ctx?.tag_id
    return Boolean(tagId && cfg?.tag_id && cfg.tag_id === tagId)
  }

  if (automation.trigger_type === 'deal_stage_changed') {
    const cfg = automation.trigger_config as DealStageChangedTriggerConfig
    const toStage = ctx?.deal_to_stage_id
    // Stage ids are pipeline-unique, so `stage_id` alone is the match;
    // `pipeline_id` in the config only scopes the builder's stage picker.
    return Boolean(toStage && cfg?.stage_id && cfg.stage_id === toStage)
  }

  return true
}

async function evaluateCondition(cfg: ConditionStepConfig, args: ExecuteArgs): Promise<boolean> {
  const db = supabaseAdmin()
  switch (cfg.subject) {
    case 'tag_presence': {
      if (!args.contactId || !cfg.operand) return false
      // contact_tags has no account_id column (its RLS keys off the parent
      // contact), so tenant scoping here relies on the contact-ownership
      // guard in runAutomationsForTrigger.
      const { count } = await db
        .from('contact_tags')
        .select('id', { count: 'exact', head: true })
        .eq('contact_id', args.contactId)
        .eq('tag_id', cfg.operand)
      return (count ?? 0) > 0
    }
    case 'contact_field': {
      if (!args.contactId || !cfg.operand) return false
      // Scope to the account so the condition can't be turned into a
      // cross-tenant read oracle via the service-role client.
      const { data } = await db
        .from('contacts')
        .select(cfg.operand)
        .eq('id', args.contactId)
        .eq('account_id', args.automation.account_id)
        .maybeSingle()
      const v = (data as Record<string, unknown> | null)?.[cfg.operand]
      return v != null && String(v) === String(cfg.value ?? '')
    }
    case 'message_content': {
      const text = (args.context.message_text ?? '').toString()
      return text.toLowerCase().includes((cfg.value ?? '').toLowerCase())
    }
    case 'variable': {
      // Branch on a workflow variable in the run context. The common
      // case: `ctwa_source_id` (and the other `ctwa_*` keys) seeded onto
      // flow_runs.vars from a Click-to-WhatsApp ad referral, then handed
      // to this automation by the flow's set_tag → tag_added dispatch
      // (tag-events.ts forwards run.vars as context.vars). `operand` is
      // the var name; comparison is exact string equality, like
      // contact_field. A var absent from the context never matches.
      if (!cfg.operand) return false
      return matchesVariableCondition(args.context.vars?.[cfg.operand], cfg.value)
    }
    case 'time_of_day': {
      // operand form "HH:mm-HH:mm" — true if now is within that window
      // (supports over-midnight ranges like "18:00-09:00").
      const [from, to] = (cfg.operand ?? '').split('-')
      if (!from || !to) return false
      const now = new Date()
      const mins = now.getHours() * 60 + now.getMinutes()
      const parse = (s: string) => {
        const [h, m] = s.split(':').map(Number)
        return (h || 0) * 60 + (m || 0)
      }
      const f = parse(from)
      const t = parse(to)
      return f <= t ? mins >= f && mins < t : mins >= f || mins < t
    }
    default:
      return false
  }
}

/**
 * Exact-equality test for the `variable` condition subject. Pure +
 * exported so engine.test can exercise it without the Supabase mock.
 * A `null`/`undefined` var (key absent from the run context) never
 * matches; a non-string var is coerced before comparison; a missing
 * `expected` compares against the empty string.
 */
export function matchesVariableCondition(
  varValue: unknown,
  expected: string | undefined,
): boolean {
  if (varValue == null) return false
  return String(varValue) === String(expected ?? '')
}

function waitMs(cfg: WaitStepConfig): number {
  const unitMs = cfg.unit === 'days' ? 86_400_000 : cfg.unit === 'hours' ? 3_600_000 : 60_000
  return Math.max(1_000, cfg.amount * unitMs)
}

function interpolate(s: string, args: ExecuteArgs): string {
  return s.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => {
    const [ns, prop] = String(key).split('.')
    if (ns === 'message' && prop === 'text') return String(args.context.message_text ?? '')
    if (ns === 'vars' && prop) return String(args.context.vars?.[prop] ?? '')
    if (ns === 'deal' && prop) {
      const c = args.context
      if (prop === 'value') return c.deal_value == null ? '' : String(c.deal_value)
      if (prop === 'currency') return c.deal_currency ?? ''
      if (prop === 'title') return c.deal_title ?? ''
      if (prop === 'id') return c.deal_id ?? ''
      return ''
    }
    return ''
  })
}

async function appendResults(
  logId: string | null,
  newItems: AutomationLogStepResult[],
  status: 'success' | 'partial' | 'failed' | null,
  errorMessage: string | null,
) {
  if (!logId) return
  const db = supabaseAdmin()
  const { data: existing } = await db
    .from('automation_logs')
    .select('steps_executed, status')
    .eq('id', logId)
    .single()
  const merged = [
    ...((existing?.steps_executed as AutomationLogStepResult[] | undefined) ?? []),
    ...newItems,
  ]
  const update: Record<string, unknown> = { steps_executed: merged }
  // Only overwrite status on the outermost scope — nested branches pass null.
  if (status !== null) {
    update.status = status
  }
  if (errorMessage) update.error_message = errorMessage
  await db.from('automation_logs').update(update).eq('id', logId)
}

async function finalizeLog(
  logId: string | null,
  status: 'success' | 'partial' | 'failed',
  errorMessage: string | null,
) {
  if (!logId) return
  await supabaseAdmin()
    .from('automation_logs')
    .update({ status, error_message: errorMessage })
    .eq('id', logId)
}

async function markPending(id: string, status: 'done' | 'failed') {
  await supabaseAdmin()
    .from('automation_pending_executions')
    .update({ status })
    .eq('id', id)
}
