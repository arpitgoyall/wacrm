import type { AdConnection, CampaignEntity } from '@/lib/ads/workspace';
import type {
  campaignReport,
  campaignRecommendations,
  Sale,
} from '@/lib/ads/workspace-report';

export interface WorkspaceDocument {
  id: string;
  name: string;
  kind: string;
  data: Record<string, unknown>;
  revision: number;
}
export interface ConversionRecord {
  id: string;
  contact_id: string;
  event_name: string;
  status: string;
  reason: string | null;
  attempt_count: number;
  duplicate_suppressed_count?: number;
  occurred_at: string;
  delivered_at: string | null;
}
export interface ChangeRecord {
  id: string;
  connection_id: string;
  entity_id: string;
  action: string;
  before_data: Record<string, unknown>;
  after_data: Record<string, unknown>;
  remote_ids: Record<string, unknown>;
  status: string;
  error: string | null;
  created_at: string;
}
export interface WorkspaceData {
  connections: AdConnection[];
  connection: AdConnection | null;
  entities: CampaignEntity[];
  documents: WorkspaceDocument[];
  events: ConversionRecord[];
  changes: ChangeRecord[];
  report: ReturnType<typeof campaignReport> | null;
  comparison: ReturnType<typeof campaignReport> | null;
  previous?: { start: string; end: string };
  recommendations: ReturnType<typeof campaignRecommendations>;
  deals: {
    id: string;
    title: string;
    contact_id: string;
    value: number;
    currency: string;
    stage_id: string;
  }[];
  stages: { id: string; name: string; pipeline_id: string }[];
  flows: { id: string; name: string }[];
  sales?: Sale[];
  role: string;
  teamType?: string | null;
  coverage?: {
    start: string | null;
    contactLimitReached: boolean;
    conversationLimitReached: boolean;
  };
  attempts: {
    id: string;
    event_id: string;
    status: number;
    accepted: boolean;
    reason: string | null;
    created_at: string;
  }[];
}
export async function adsRequest<T = Record<string, unknown>>(
  path: string,
  body?: unknown
): Promise<T> {
  const response = await fetch(
    path,
    body === undefined
      ? { cache: 'no-store' }
      : {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }
  );
  const data = await response.json().catch(() => ({}));
  if (!response.ok)
    throw Error(
      data.error || 'The campaign workspace could not complete this request'
    );
  return data as T;
}
export const fieldClass =
  'border-border bg-background text-foreground w-full rounded-lg border px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-50';
export function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
