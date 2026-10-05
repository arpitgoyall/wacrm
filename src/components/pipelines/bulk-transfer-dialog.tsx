'use client';

import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ArrowRightLeft, Loader2 } from 'lucide-react';
import { toast } from 'sonner';

import type { Deal, Profile } from '@/types';
import { canSendMessages } from '@/lib/auth/roles';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

interface BulkTransferDialogProps {
  /** Only the leads selected on the board, from the chosen sending agent. */
  deals: Deal[];
  agents: Profile[];
  sourceProfileId: string;
  onOpenChange: (open: boolean) => void;
  onTransferred: () => Promise<void>;
}

// Selection happens on the board. This dialog reviews exactly those leads.
export function BulkTransferDialog({
  deals,
  agents,
  sourceProfileId,
  onOpenChange,
  onTransferred,
}: BulkTransferDialogProps) {
  const t = useTranslations('Pipelines.transfer');
  const sourceId = sourceProfileId;
  const [targetId, setTargetId] = useState('');
  const [transferring, setTransferring] = useState(false);
  const submitting = useRef(false);

  const selectedDealIds = deals.map((deal) => deal.id);
  const source = agents.find((agent) => agent.id === sourceId);
  const recipients = agents.filter(
    (agent) => agent.account_role && canSendMessages(agent.account_role)
  );

  async function handleTransfer() {
    if (
      submitting.current ||
      !sourceId ||
      !targetId ||
      sourceId === targetId ||
      selectedDealIds.length === 0 ||
      selectedDealIds.length > 1000
    )
      return;

    submitting.current = true;
    setTransferring(true);
    let result: { dealsTransferred: number; conversationsTransferred: number };
    try {
      const response = await fetch('/api/deals/bulk-transfer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourceProfileId: sourceId,
          targetProfileId: targetId,
          dealIds: selectedDealIds,
        }),
      });
      const body = await response.json();
      if (!response.ok) {
        toast.error(body.error || t('failed'));
        if (response.status === 409) {
          onOpenChange(false);
          await onTransferred();
        }
        return;
      }
      result = body;
    } catch {
      toast.error(t('failed'));
      return;
    } finally {
      submitting.current = false;
      setTransferring(false);
    }

    toast.success(
      t('success', {
        deals: result.dealsTransferred,
        conversations: result.conversationsTransferred,
      })
    );
    onOpenChange(false);
    await onTransferred();
  }

  const selectClassName =
    'border-input bg-background text-foreground h-9 w-full rounded-lg border px-3 text-sm disabled:opacity-50';

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!submitting.current) onOpenChange(open);
      }}
    >
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="transfer-source">{t('fromAgent')}</Label>
            <Input
              id="transfer-source"
              value={source?.full_name || source?.email || ''}
              readOnly
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="transfer-target">{t('toAgent')}</Label>
            <select
              id="transfer-target"
              value={targetId}
              disabled={transferring}
              className={selectClassName}
              onChange={(event) => setTargetId(event.target.value)}
            >
              <option value="">{t('selectAgent')}</option>
              {recipients
                .filter((agent) => agent.id !== sourceId)
                .map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.full_name || agent.email}
                  </option>
                ))}
            </select>
          </div>
        </div>

        <div className="overflow-hidden rounded-lg border">
          <p className="bg-muted/50 border-b p-3 text-sm font-medium">
            {t('reviewSelected', { count: deals.length })}
          </p>
          <ul className="max-h-64 overflow-y-auto">
            {deals.map((deal) => (
              <li
                key={deal.id}
                className="space-y-1 border-b p-3 last:border-0"
              >
                <p className="truncate text-sm font-medium">{deal.title}</p>
                <p className="text-muted-foreground truncate text-xs">
                  {deal.contact?.name || deal.contact?.phone || t('noContact')}
                </p>
              </li>
            ))}
          </ul>
        </div>

        <p className="text-muted-foreground text-xs">{t('inboxNotice')}</p>
        {selectedDealIds.length > 1000 && (
          <p role="alert" className="text-destructive text-sm">
            {t('batchLimit')}
          </p>
        )}
        <DialogFooter>
          <Button
            variant="outline"
            disabled={transferring}
            onClick={() => onOpenChange(false)}
          >
            {t('cancel')}
          </Button>
          <Button
            disabled={
              transferring ||
              !sourceId ||
              !targetId ||
              selectedDealIds.length === 0 ||
              selectedDealIds.length > 1000
            }
            onClick={handleTransfer}
          >
            {transferring ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <ArrowRightLeft className="h-4 w-4" />
            )}
            {transferring
              ? t('transferring')
              : t('transferCount', { count: selectedDealIds.length })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
