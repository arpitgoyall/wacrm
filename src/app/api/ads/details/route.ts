import { NextResponse } from 'next/server';
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import {
  allRows,
  type CampaignEntity,
  type AdConnection,
} from '@/lib/ads/workspace';
import { previousPeriod, type DailyInsight } from '@/lib/ads/workspace-report';
export async function GET(request: Request) {
  try {
    const ctx = await getCurrentAccount(),
      p = new URL(request.url).searchParams;
    const connectionId = p.get('connection') || '',
      entityId = p.get('entity') || '',
      start = p.get('start') || '',
      end = p.get('end') || '';
    try {
      previousPeriod(start, end);
    } catch {
      return NextResponse.json(
        { error: 'Invalid reporting dates' },
        { status: 400 }
      );
    }
    const connections = await allRows<AdConnection>(
      'ads_connections',
      ctx.accountId
    );
    if (!connections.some((c) => c.id === connectionId))
      return NextResponse.json(
        { error: 'Ad account not found' },
        { status: 404 }
      );
    const entities = await allRows<CampaignEntity>(
      'ads_entities',
      ctx.accountId,
      { key: 'connection_id', value: connectionId }
    );
    const selected = entities.find((e) => e.meta_id === entityId);
    if (!selected)
      return NextResponse.json(
        { error: 'Campaign item not found' },
        { status: 404 }
      );
    const setIds = new Set(
      entities
        .filter((e) => e.kind === 'adset' && e.parent_id === entityId)
        .map((e) => e.meta_id)
    );
    const adIds = new Set(
      selected.kind === 'ad'
        ? [selected.meta_id]
        : entities
            .filter(
              (e) =>
                e.kind === 'ad' &&
                (e.parent_id === entityId || setIds.has(e.parent_id || ''))
            )
            .map((e) => e.meta_id)
    );
    const insights = await allRows<DailyInsight>(
      'ads_daily_insights',
      ctx.accountId,
      { key: 'connection_id', value: connectionId }
    );
    const daily = new Map<
      string,
      { date: string; spend: number; clicks: number; messaging: number }
    >();
    for (const i of insights)
      if (adIds.has(i.ad_id) && i.date >= start && i.date <= end) {
        const row = daily.get(i.date) || {
          date: i.date,
          spend: 0,
          clicks: 0,
          messaging: 0,
        };
        row.spend += Number(i.spend);
        row.clicks += Number(i.clicks);
        row.messaging += Number(i.messaging);
        daily.set(i.date, row);
      }
    return NextResponse.json({
      daily: [...daily.values()].sort((a, b) => a.date.localeCompare(b.date)),
    });
  } catch (e) {
    return toErrorResponse(e);
  }
}
