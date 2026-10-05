'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useCurrentTime } from '@/hooks/use-current-time';
import { daysSinceCreation } from '@/lib/created-age';
import { cn } from '@/lib/utils';

interface CreatedAgeProps {
  createdAt: string;
  className?: string;
}

export function CreatedAge({ createdAt, className }: CreatedAgeProps) {
  const t = useTranslations('CreatedAge');
  const locale = useLocale();
  const now = useCurrentTime();
  const days = now === null ? null : daysSinceCreation(createdAt, now);

  // Wait for the browser clock so server and client hydration agree.
  if (days === null) return null;

  return (
    <time
      dateTime={createdAt}
      title={t('createdOn', {
        date: new Date(createdAt).toLocaleString(locale, {
          dateStyle: 'medium',
          timeStyle: 'short',
        }),
      })}
      className={cn(
        'text-muted-foreground text-[10px] leading-none whitespace-nowrap',
        className
      )}
    >
      {t('daysAgo', { count: days })}
    </time>
  );
}
