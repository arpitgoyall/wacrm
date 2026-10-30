'use client';

import { useEffect, useRef } from 'react';
import type { EChartsOption } from 'echarts';
import { cn } from '@/lib/utils';

export function EChart({
  option,
  className,
  label,
}: {
  option: EChartsOption;
  className?: string;
  label: string;
}) {
  const element = useRef<HTMLDivElement>(null);
  const chart = useRef<import('echarts').EChartsType | null>(null);
  const latestOption = useRef(option);
  latestOption.current = option;

  useEffect(() => {
    let active = true;
    let resize: ResizeObserver | undefined;
    void import('echarts').then((echarts) => {
      if (!active || !element.current) return;
      const instance = echarts.init(element.current, undefined, {
        renderer: 'svg',
      });
      chart.current = instance;
      instance.setOption(latestOption.current, { notMerge: true });
      resize = new ResizeObserver(() => instance.resize());
      resize.observe(element.current);
    });
    return () => {
      active = false;
      resize?.disconnect();
      chart.current?.dispose();
      chart.current = null;
    };
  }, []);

  useEffect(() => {
    chart.current?.setOption(option, { notMerge: true });
  }, [option]);

  return (
    <div
      ref={element}
      role="img"
      aria-label={label}
      className={cn('h-full w-full', className)}
    />
  );
}
