'use client';
import { useEffect, useState } from 'react';
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
} from 'recharts';
import { adsRequest } from './workspace-types';
export function CampaignDetailTrend({
  connection,
  entity,
  start,
  end,
  currency,
}: {
  connection: string;
  entity: string;
  start: string;
  end: string;
  currency: string;
}) {
  const [daily, setDaily] = useState<{ date: string; spend: number }[]>([]),
    [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    adsRequest<{ daily: typeof daily }>(
      `/api/ads/details?connection=${connection}&entity=${entity}&start=${start}&end=${end}`
    )
      .then((r) => {
        if (active) setDaily(r.daily);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [connection, entity, start, end]);
  return (
    <section className="mt-5">
      <h3 className="text-sm font-semibold">Daily spend ({currency})</h3>
      {error ? (
        <p role="alert" className="text-destructive text-xs">
          {error}
        </p>
      ) : daily.length ? (
        <div className="mt-3 h-44">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={daily}>
              <XAxis dataKey="date" minTickGap={40} />
              <YAxis />
              <Tooltip />
              <Line dataKey="spend" stroke="#3b82f6" dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <p className="text-muted-foreground mt-3 text-xs">
          No stored spend for this item in the selected period.
        </p>
      )}
    </section>
  );
}
