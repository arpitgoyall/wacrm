import { queueStageOutcome } from '@/lib/ads/outcomes';

export type BuiltInMetaEvent = 'LeadSubmitted' | 'Purchase';

export function metaEventForStage(stageName: string): BuiltInMetaEvent | null {
  switch (stageName.trim().toLowerCase()) {
    case 'qualified':
      return 'LeadSubmitted';
    case 'enrolled':
      return 'Purchase';
    default:
      return null;
  }
}

export type DealStageConversionResult =
  | { status: 'sent'; eventName: BuiltInMetaEvent; responseStatus: number }
  | { status: 'skipped'; reason: string; eventName?: BuiltInMetaEvent }
  | { status: 'failed'; error: string; eventName?: BuiltInMetaEvent };

export async function dispatchBuiltInDealStageConversion(
  eventId: string
): Promise<DealStageConversionResult> {
  try {
    return await queueStageOutcome(eventId);
  } catch (err) {
    return {
      status: 'failed',
      error: err instanceof Error ? err.message : 'Outcome recording failed',
    };
  }
}
