import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';

function isUuid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value
    )
  );
}

export async function POST(request: Request) {
  try {
    // Admin is the app's manager role. The RPC repeats the permission and
    // account checks so calling it directly cannot bypass this route.
    const ctx = await requireRole('admin');
    const limit = checkRateLimit(
      `admin:bulkTransferDeals:${ctx.userId}`,
      RATE_LIMITS.adminAction
    );
    if (!limit.success) return rateLimitResponse(limit);

    const body = await request.json().catch(() => null);
    if (
      !isUuid(body?.sourceProfileId) ||
      !isUuid(body?.targetProfileId) ||
      body.sourceProfileId.toLowerCase() === body.targetProfileId.toLowerCase()
    ) {
      return NextResponse.json(
        { error: 'Choose two different agents with valid profile IDs' },
        { status: 400 }
      );
    }
    if (
      !Array.isArray(body.dealIds) ||
      body.dealIds.length === 0 ||
      body.dealIds.length > 1000 ||
      !body.dealIds.every(isUuid) ||
      new Set(body.dealIds.map((id: string) => id.toLowerCase())).size !==
        body.dealIds.length
    ) {
      return NextResponse.json(
        { error: 'Select between 1 and 1000 unique leads with valid IDs' },
        { status: 400 }
      );
    }

    const { data, error } = await ctx.supabase.rpc('bulk_transfer_deals', {
      p_source_profile_id: body.sourceProfileId,
      p_target_profile_id: body.targetProfileId,
      p_deal_ids: body.dealIds,
    });
    if (error) {
      const status =
        error.code === '42501'
          ? 403
          : error.code === '22023'
            ? 400
            : error.code === '40001'
              ? 409
              : 500;
      if (status === 500) console.error('[bulk-transfer-deals]', error);
      return NextResponse.json(
        { error: status === 500 ? 'Failed to transfer leads' : error.message },
        { status }
      );
    }

    return NextResponse.json({ ok: true, ...data });
  } catch (error) {
    return toErrorResponse(error);
  }
}
