import { NextResponse } from 'next/server';
import { checkCronAuth } from '@/lib/cron-auth';
import { syncWorkspaceAccounts } from '@/lib/ads/workspace-sync';
import { drainConversionEvents } from '@/lib/ads/outcomes';
import { evaluateWorkspaceRules } from '@/lib/ads/qualification';
export const maxDuration = 300;
export async function GET(request: Request) {
  const auth = checkCronAuth(request);
  if (!auth.ok)
    return NextResponse.json(
      { error: 'Cron authentication required' },
      { status: auth.status }
    );
  const qualification = await evaluateWorkspaceRules();
  const conversions = await drainConversionEvents();
  const sync = await syncWorkspaceAccounts();
  return NextResponse.json({ qualification, conversions, sync });
}
