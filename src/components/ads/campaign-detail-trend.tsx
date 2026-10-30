'use client';
import { useEffect, useState } from 'react';
import { EChart } from '@/components/charts/echart';
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
          <EChart
            label={`Daily spend in ${currency}`}
            option={{
              grid: { top: 15, right: 15, bottom: 30, left: 50 },
              tooltip: { trigger: 'axis' },
              xAxis: {
                type: 'category',
                data: daily.map((day) => day.date),
                axisLabel: { color: '#8b929e', hideOverlap: true },
                axisLine: { show: false },
                axisTick: { show: false },
              },
              yAxis: {
                type: 'value',
                min: 0,
                axisLabel: { color: '#8b929e' },
                splitLine: { lineStyle: { color: '#e5e7eb', type: 'dashed' } },
              },
              series: [
                {
                  type: 'line',
                  name: `Spend (${currency})`,
                  data: daily.map((day) => day.spend),
                  showSymbol: false,
                  smooth: 0.25,
                  lineStyle: { color: '#3b82f6', width: 2 },
                  itemStyle: { color: '#3b82f6' },
                  areaStyle: { color: 'rgba(59,130,246,0.08)' },
                },
              ],
            }}
          />
        </div>
      ) : (
        <p className="text-muted-foreground mt-3 text-xs">
          No stored spend for this item in the selected period.
        </p>
      )}
    </section>
  );
}
