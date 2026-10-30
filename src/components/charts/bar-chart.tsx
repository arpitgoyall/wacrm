'use client';

import { EChart } from './echart';

const palette: Record<string, string> = {
  violet: '#7c3aed',
  blue: '#3b82f6',
  emerald: '#10b981',
  amber: '#f59e0b',
};

export function BarChart({
  data,
  index,
  categories,
  colors = ['violet'],
  valueFormatter = (value) => String(value),
  showLegend = true,
  yAxisWidth = 48,
  className,
}: {
  data: Record<string, string | number>[];
  index: string;
  categories: string[];
  colors?: string[];
  valueFormatter?: (value: number) => string;
  showLegend?: boolean;
  yAxisWidth?: number;
  className?: string;
}) {
  return (
    <EChart
      className={className}
      label={`${categories.join(', ')} by ${index}`}
      option={{
        color: colors.map((color) => palette[color] ?? color),
        grid: {
          top: showLegend ? 35 : 12,
          right: 12,
          bottom: 28,
          left: yAxisWidth,
        },
        legend: { show: showLegend, top: 0, textStyle: { color: '#8b929e' } },
        tooltip: {
          trigger: 'axis',
          valueFormatter: (value) => valueFormatter(Number(value)),
        },
        xAxis: {
          type: 'category',
          data: data.map((row) => String(row[index])),
          axisLabel: { color: '#8b929e', hideOverlap: true },
          axisLine: { show: false },
          axisTick: { show: false },
        },
        yAxis: {
          type: 'value',
          min: 0,
          axisLabel: {
            color: '#8b929e',
            formatter: (value: number) => valueFormatter(value),
          },
          splitLine: { lineStyle: { color: '#e5e7eb', type: 'dashed' } },
        },
        series: categories.map((category) => ({
          type: 'bar' as const,
          name: category,
          data: data.map((row) => Number(row[category] ?? 0)),
          barMaxWidth: 32,
          itemStyle: { borderRadius: [4, 4, 0, 0] },
        })),
      }}
    />
  );
}
