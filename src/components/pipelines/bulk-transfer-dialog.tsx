'use client';

import { useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ArrowRightLeft, Loader2 } from 'lucide-react';
import { toast } from 'sonner';

import type { Deal, Profile } from '@/types';
import { canSendMessages } from '@/lib/auth/roles';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
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
  deals: Deal[];
  agents: Profile[];
  initialSourceId?: string;
  onOpenChange: (open: boolean) => void;
  onTransferred: () => Promise<void>;
}

// Mounted only while open, so selections never survive closing the dialog
// or switching the account/pipeline. `deals` already respects board filters.
export function BulkTransferDialog({
  deals,
  agents,
  initialSourceId,
  onOpenChange,
  onTransferred,
}: BulkTransferDialogProps) {
  const t = useTranslations('Pipelines.transfer');
  const [sourceId, setSourceId] = useState(
    initialSourceId ??
      agents.find((agent) =>
        deals.some((deal) => deal.assigned_to === agent.id)
      )?.id ??
      ''
  );
  const [targetId, setTargetId] = useState('');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [transferring, setTransferring] = useState(false);
  const submitting = useRef(false);

  const eligibleDeals = useMemo(
    () => deals.filter((deal) => deal.assigned_to === sourceId),
    [deals, sourceId]
  );
  const eligibleIds = new Set(eligibleDeals.map((deal) => deal.id));
  const selectedDealIds = selectedIds.filter((id) => eligibleIds.has(id));
  const selectedSet = new Set(selectedDealIds);
  const batchDeals = eligibleDeals.slice(0, 1000);
  const allSelected =
    batchDeals.length > 0 &&
    batchDeals.every((deal) => selectedSet.has(deal.id));
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
          setSelectedIds([]);
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
            <select
              id="transfer-source"
              value={sourceId}
              disabled={transferring}
              className={selectClassName}
              onChange={(event) => {
                const id = event.target.value;
                setSourceId(id);
                setSelectedIds([]);
                if (targetId === id) setTargetId('');
              }}
            >
              <option value="">{t('selectAgent')}</option>
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.full_name || agent.email}
                </option>
              ))}
            </select>
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
          <div className="bg-muted/50 flex items-center gap-3 border-b p-3">
            <Checkbox
              id="transfer-select-all"
              checked={allSelected}
              indeterminate={selectedDealIds.length > 0 && !allSelected}
              disabled={transferring || eligibleDeals.length === 0}
              onCheckedChange={(checked) =>
                setSelectedIds(checked ? batchDeals.map((deal) => deal.id) : [])
              }
            />
            <Label htmlFor="transfer-select-all" className="flex-1">
              {eligibleDeals.length > 1000 ? t('selectBatch') : t('selectAll')}
            </Label>
            <span aria-live="polite" className="text-muted-foreground text-xs">
              {t('selectedCount', {
                selected: selectedDealIds.length,
                total: eligibleDeals.length,
              })}
            </span>
          </div>
          <div className="max-h-64 overflow-y-auto">
            {eligibleDeals.length === 0 ? (
              <p className="text-muted-foreground p-6 text-center text-sm">
                {t('noLeads')}
              </p>
            ) : (
              eligibleDeals.map((deal) => (
                <div
                  key={deal.id}
                  className="flex items-center gap-3 border-b p-3 last:border-0"
                >
                  <Checkbox
                    id={`transfer-deal-${deal.id}`}
                    checked={selectedSet.has(deal.id)}
                    disabled={transferring}
                    onCheckedChange={(checked) =>
                      setSelectedIds((current) =>
                        checked
                          ? [...current.filter((id) => id !== deal.id), deal.id]
                          : current.filter((id) => id !== deal.id)
                      )
                    }
                  />
                  <Label
                    htmlFor={`transfer-deal-${deal.id}`}
                    className="min-w-0 flex-1 flex-col items-start gap-1"
                  >
                    <span className="w-full truncate">{deal.title}</span>
                    <span className="text-muted-foreground w-full truncate text-xs font-normal">
                      {deal.contact?.name ||
                        deal.contact?.phone ||
                        t('noContact')}
                    </span>
                  </Label>
                </div>
              ))
            )}
          </div>
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
