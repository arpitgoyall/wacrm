import {
  AiError,
  LEAD_CARD_KEYS,
  type AiConfig,
  type AiUsage,
  type ChatMessage,
  type GenerateResult,
  type LeadCard,
  type LeadOutcome,
} from './types';
import {
  HANDOFF_SENTINEL,
  META_SENTINEL,
  SKIP_SENTINEL,
  aiRequestTimeoutMs,
} from './defaults';
import { generateOpenAi } from './providers/openai';
import { generateAnthropic } from './providers/anthropic';

export interface GenerateArgs {
  config: AiConfig;
  /** Fully-built system prompt (see `buildSystemPrompt`). */
  systemPrompt: string;
  /** Recent conversation turns, oldest first. */
  messages: ChatMessage[];
}

/**
 * Generate the next reply from the account's configured provider.
 * Dispatches to the right adapter, then parses the handoff sentinel out
 * of the raw text. Throws `AiError` on any provider/network failure.
 */
export async function generateReply(
  args: GenerateArgs
): Promise<GenerateResult> {
  const { config, systemPrompt, messages } = args;
  const timeoutMs = aiRequestTimeoutMs();
  const providerArgs = {
    apiKey: config.apiKey,
    model: config.model,
    systemPrompt,
    messages,
    timeoutMs,
  };

  let result: { text: string; usage: AiUsage | null };
  switch (config.provider) {
    case 'openai':
      result = await generateOpenAi(providerArgs);
      break;
    case 'openrouter':
      result = await generateOpenAi(providerArgs, 'openrouter');
      break;
    case 'anthropic':
      result = await generateAnthropic(providerArgs);
      break;
    default:
      throw new AiError(`Unsupported AI provider: ${config.provider}`, {
        code: 'unsupported_provider',
        status: 400,
      });
  }

  return parseGeneration(result.text, result.usage);
}

/**
 * Split the raw model output into `{ text, handoff, usage }`. The
 * sentinel can appear alone or trailing a partial reply; either way we
 * treat the turn as a handoff and strip the marker from any remaining
 * text. `usage` is passed straight through (null when the provider
 * didn't report it).
 */
export function parseGeneration(
  raw: string,
  usage: AiUsage | null = null
): GenerateResult {
  // Split off the machine-readable [[META]] tail first so it can never
  // leak into the customer-facing text, even when the JSON is malformed.
  let body = raw;
  let outcome: LeadOutcome | null = null;
  let lead: LeadCard | null = null;
  const metaAt = raw.indexOf(META_SENTINEL);
  if (metaAt !== -1) {
    body = raw.slice(0, metaAt);
    const parsed = parseMeta(raw.slice(metaAt + META_SENTINEL.length));
    outcome = parsed.outcome;
    lead = parsed.lead;
  }

  const skip = body.includes(SKIP_SENTINEL);
  const handoff = body.includes(HANDOFF_SENTINEL) || outcome === 'needs_human';
  const text = body
    .split(HANDOFF_SENTINEL)
    .join('')
    .split(SKIP_SENTINEL)
    .join('')
    .trim();
  const result: GenerateResult = { text, handoff, usage };
  // Only present when the model actually emitted them (keeps the plain
  // draft-mode result shape unchanged).
  if (metaAt !== -1) {
    result.outcome = outcome;
    result.lead = lead;
  }
  if (skip) result.skip = true;
  return result;
}

const OUTCOMES: readonly LeadOutcome[] = [
  'continue',
  'qualified',
  'lost',
  'needs_human',
];

/** Best-effort parse of `{"outcome":..., "lead":{...}}`. Anything invalid
 *  degrades to nulls — a bad meta line must never break the reply. */
function parseMeta(tail: string): {
  outcome: LeadOutcome | null;
  lead: LeadCard | null;
} {
  const start = tail.indexOf('{');
  const end = tail.lastIndexOf('}');
  if (start === -1 || end <= start) return { outcome: null, lead: null };
  try {
    const obj = JSON.parse(tail.slice(start, end + 1)) as {
      outcome?: unknown;
      lead?: unknown;
    };
    const outcome = OUTCOMES.includes(obj.outcome as LeadOutcome)
      ? (obj.outcome as LeadOutcome)
      : null;
    let lead: LeadCard | null = null;
    if (obj.lead && typeof obj.lead === 'object') {
      const out: LeadCard = {};
      for (const key of LEAD_CARD_KEYS) {
        const v = (obj.lead as Record<string, unknown>)[key];
        if (typeof v === 'string' && v.trim()) out[key] = v.trim().slice(0, 200);
      }
      lead = Object.keys(out).length ? out : null;
    }
    return { outcome, lead };
  } catch {
    return { outcome: null, lead: null };
  }
}
