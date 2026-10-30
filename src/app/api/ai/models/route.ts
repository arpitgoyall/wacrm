import { NextResponse } from 'next/server';
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';

interface OpenRouterModel {
  id: string;
  name: string;
  context_length?: number;
  pricing?: { prompt?: string; completion?: string };
  architecture?: { output_modalities?: string[] };
}

/** List free text models without exposing or requiring a provider API key. */
export async function GET() {
  try {
    const { userId } = await getCurrentAccount();
    const limit = checkRateLimit(
      `ai-models:${userId}`,
      RATE_LIMITS.adminAction
    );
    if (!limit.success) return rateLimitResponse(limit);

    try {
      const response = await fetch('https://openrouter.ai/api/v1/models', {
        next: { revalidate: 300 },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error('OpenRouter model catalog unavailable');
      const payload = await response.json();
      if (!Array.isArray(payload?.data))
        throw new Error('Invalid model catalog');
      const models = (payload.data as OpenRouterModel[])
        .filter(
          (model) =>
            typeof model.id === 'string' &&
            model.pricing?.prompt != null &&
            model.pricing?.completion != null &&
            Number(model.pricing.prompt) === 0 &&
            Number(model.pricing.completion) === 0 &&
            (!model.architecture?.output_modalities ||
              model.architecture.output_modalities.includes('text'))
        )
        .map(({ id, name, context_length }) => ({
          id,
          name: name || id,
          context_length,
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
      return NextResponse.json({ models });
    } catch {
      return NextResponse.json(
        { error: 'Could not load free OpenRouter models. Please try again.' },
        { status: 502 }
      );
    }
  } catch (error) {
    return toErrorResponse(error);
  }
}
