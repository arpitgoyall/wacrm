// ============================================================
// Shared types for the AI reply assistant (bring-your-own-key).
//
// One small provider-agnostic surface so the inbox draft route and the
// inbound auto-reply bot both talk to `generateReply` without caring
// whether the account is on OpenAI or Anthropic.
// ============================================================

export type AiProvider = 'openai' | 'anthropic' | 'openrouter';

/**
 * Account AI setup, decrypted and ready to use. Produced by
 * `loadAiConfig` — `apiKey` is the plaintext BYO provider key
 * (stored AES-256-GCM-encrypted at rest).
 */
export interface AiConfig {
  provider: AiProvider;
  model: string;
  apiKey: string;
  systemPrompt: string | null;
  isActive: boolean;
  autoReplyEnabled: boolean;
  autoReplyMaxPerConversation: number;
  /** Where auto-reply hands a conversation off when the model bails: an
   *  agent's `auth.users.id`, or null to leave it unassigned (drop into
   *  the shared queue). */
  handoffAgentId: string | null;
  /** Optional OpenAI-compatible key for embeddings. When set, the
   *  knowledge base is embedded and semantic retrieval turns on; when
   *  null, retrieval falls back to lexical full-text search. */
  embeddingsApiKey: string | null;
  /** New-lead outreach + re-engagement settings (migration 081). Optional
   *  so callers that only need chat settings can omit it. */
  proactive?: AiProactiveSettings;
  /** Lead-qualification outcomes → pipeline stages (migration 082). */
  lead?: AiLeadSettings;
}

/** What the AI decided about the lead after a turn. */
export type LeadOutcome = 'continue' | 'qualified' | 'lost' | 'needs_human';

/** Facts the AI has learned about a lead. All optional, short strings. */
export interface LeadCard {
  name?: string;
  occupation?: string;
  goal?: string;
  experience?: string;
  intent?: string;
  objection?: string;
  city?: string;
}

export const LEAD_CARD_KEYS = [
  'name',
  'occupation',
  'goal',
  'experience',
  'intent',
  'objection',
  'city',
] as const satisfies readonly (keyof LeadCard)[];

/** Where each outcome moves the lead's open deal, and what "qualified"
 *  means for this account. Any stage id may be null (= don't move). */
export interface AiLeadSettings {
  pipelineId: string | null;
  stageQualifiedId: string | null;
  stageLostId: string | null;
  stageNotRespondingId: string | null;
  stageFollowUpId: string | null;
  criteria: string | null;
}

/** Proactive (agent-initiated) messaging settings. */
export interface AiProactiveSettings {
  outreachEnabled: boolean;
  outreachEnabledAt: string | null;
  outreachTemplateName: string | null;
  outreachDelayMinutes: number;
  followupEnabled: boolean;
  followupEnabledAt: string | null;
  followupTemplateName: string | null;
  followupFirstDelayHours: number;
  followupIntervalHours: number;
  followupMaxAttempts: number;
  templateLanguage: string;
  dailyCap: number;
  /** Promotional follow-ups only go out between these local hours. */
  sendStartHour: number;
  sendEndHour: number;
  timezone: string;
}

/** A single conversation turn in the shape both providers accept. */
export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * Token counts for one provider call, normalized across OpenAI
 * (`prompt`/`completion`) and Anthropic (`input`/`output`). Null when
 * the provider didn't return usage. Logged to `ai_usage_log`.
 */
export interface AiUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/** Raw text + usage a provider adapter returns before handoff parsing. */
export interface ProviderResult {
  text: string;
  usage: AiUsage | null;
}

/** Outcome of a generation call. */
export interface GenerateResult {
  /** The reply text, with any handoff sentinel stripped. */
  text: string;
  /** True when the model asked to hand off to a human (auto-reply mode). */
  handoff: boolean;
  /** Provider token usage for this call, or null when unavailable. */
  usage: AiUsage | null;
  /** Structured lead outcome, when the model emitted one (auto-reply /
   *  follow-up modes). Null when absent or unparseable. */
  outcome?: LeadOutcome | null;
  /** Lead facts the model reported this turn (only non-empty keys). */
  lead?: LeadCard | null;
  /** Follow-up mode: the model judged a nudge unhelpful right now. */
  skip?: boolean;
}

/**
 * Typed error for every AI failure mode. `status` maps cleanly to an
 * HTTP response in the draft route; `code` lets the UI/tests branch
 * (invalid_key vs rate_limited vs timeout, etc.).
 */
export class AiError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(message: string, opts: { code?: string; status?: number } = {}) {
    super(message);
    this.name = 'AiError';
    this.code = opts.code ?? 'ai_error';
    this.status = opts.status ?? 502;
  }
}
