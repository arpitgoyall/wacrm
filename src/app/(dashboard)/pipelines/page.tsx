'use client';

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { createClient } from '@/lib/supabase/client';
import { loadPipelineDeals } from '@/lib/pipelines/load-deals';
import {
  selectedBoardDeals,
  updateDealSelection,
} from '@/lib/pipelines/deal-selection';
import type { Pipeline, PipelineStage, Deal, Profile } from '@/types';
import { PipelineBoard } from '@/components/pipelines/pipeline-board';
import { PipelineSettings } from '@/components/pipelines/pipeline-settings';
import { DealForm } from '@/components/pipelines/deal-form';
import { BulkTransferDialog } from '@/components/pipelines/bulk-transfer-dialog';
import { PipelineAnalytics } from '@/components/pipelines/pipeline-analytics';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  GitBranch,
  Plus,
  ChevronDown,
  Settings,
  ArrowRightLeft,
} from 'lucide-react';
import { toast } from 'sonner';
import { useCan } from '@/hooks/use-can';
import { useAuth } from '@/hooks/use-auth';
import { GatedButton } from '@/components/ui/gated-button';
import { useTranslations } from 'next-intl';

// Pipeline creation is admin-class (settings-tier write under
// the new RLS); deal creation is operational and only requires
// agent+. The two CTAs gate on different `useCan` capabilities,
// not on different copy.

// Spec-defined seed — name and color per the product spec.
const SPEC_DEFAULT_STAGES = [
  { name: 'New Lead', color: '#3b82f6', position: 0 }, // blue
  { name: 'Qualified', color: '#eab308', position: 1 }, // yellow
  { name: 'Proposal Sent', color: '#f97316', position: 2 }, // orange
  { name: 'Negotiation', color: '#8b5cf6', position: 3 }, // purple
  { name: 'Won', color: '#22c55e', position: 4 }, // green
];

export default function PipelinesPage() {
  const t = useTranslations('Pipelines.page');
  const supabase = createClient();
  const canEditSettings = useCan('edit-settings');
  const canCreateDeals = useCan('send-messages');
  const canTransferDeals = useCan('transfer-deals');
  const { accountId } = useAuth();

  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [selectedPipelineId, setSelectedPipelineId] = useState<string>('');
  const [stages, setStages] = useState<PipelineStage[]>([]);
  const [deals, setDeals] = useState<Deal[]>([]);
  const [agents, setAgents] = useState<Profile[]>([]);
  const [selectedAgentIds, setSelectedAgentIds] = useState<string[]>([]);
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [loading, setLoading] = useState(true);

  // Dialog / sheet state
  const [newPipelineOpen, setNewPipelineOpen] = useState(false);
  const [newPipelineName, setNewPipelineName] = useState('');
  const [creating, setCreating] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [bulkTransferOpen, setBulkTransferOpen] = useState(false);
  const [bulkSelection, setBulkSelection] = useState<{
    scope: string;
    enabled: boolean;
    sourceId: string;
    dealIds: string[];
  }>({ scope: '', enabled: false, sourceId: '', dealIds: [] });

  // Deal form state is lifted here so both the top-bar "Add Deal" and
  // the per-column "+" trigger the same Sheet.
  const [dealFormOpen, setDealFormOpen] = useState(false);
  const [editingDeal, setEditingDeal] = useState<Deal | null>(null);
  const [defaultStageId, setDefaultStageId] = useState<string>('');

  // Guard against double-seeding (React StrictMode double-effect in dev).
  const seedAttempted = useRef(false);

  const loadPipelines = useCallback(async () => {
    const { data, error } = await supabase
      .from('pipelines')
      .select('*')
      .order('created_at');
    if (error) {
      console.error('Failed to load pipelines:', error.message);
      return [];
    }
    return data ?? [];
  }, [supabase]);

  const loadStages = useCallback(
    async (pipelineId: string) => {
      const { data } = await supabase
        .from('pipeline_stages')
        .select('*')
        .eq('pipeline_id', pipelineId)
        .order('position');
      return data ?? [];
    },
    [supabase]
  );

  const loadDeals = useCallback(
    async (pipelineId: string) => {
      try {
        return await loadPipelineDeals(supabase, pipelineId);
      } catch (error) {
        console.error('Failed to load deals:', error);
        toast.error(t('toastFailedLoadDeals'));
        return [];
      }
    },
    [supabase, t]
  );

  useEffect(() => {
    if (!canTransferDeals || !accountId) return;
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from('profiles')
        .select('*')
        .eq('account_id', accountId)
        .order('full_name');
      if (!cancelled) {
        setAgents((data ?? []) as Profile[]);
        if (error) toast.error(t('toastFailedLoadAgents'));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [accountId, canTransferDeals, supabase, t]);

  const seedDefaultPipeline =
    useCallback(async (): Promise<Pipeline | null> => {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const user = session?.user;
      if (!user) return null;
      // pipelines.account_id is NOT NULL post-017 with no DB default.
      if (!accountId) return null;

      const { data: pipeline, error } = await supabase
        .from('pipelines')
        .insert({
          user_id: user.id,
          account_id: accountId,
          name: 'Sales Pipeline',
        })
        .select()
        .single();

      if (error || !pipeline) {
        console.error('Failed to seed pipeline:', error?.message);
        return null;
      }

      const stagesPayload = SPEC_DEFAULT_STAGES.map((s) => ({
        pipeline_id: pipeline.id,
        name: s.name,
        color: s.color,
        position: s.position,
      }));
      await supabase.from('pipeline_stages').insert(stagesPayload);

      return pipeline as Pipeline;
    }, [supabase, accountId]);

  // Initial load + seed-if-empty
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      let list = await loadPipelines();

      if (list.length === 0 && !seedAttempted.current) {
        seedAttempted.current = true;
        const seeded = await seedDefaultPipeline();
        if (seeded) list = await loadPipelines();
      }

      if (cancelled) return;
      setPipelines(list);
      if (list.length > 0) {
        setSelectedPipelineId((prev) =>
          prev && list.some((p) => p.id === prev) ? prev : list[0].id
        );
      } else {
        setSelectedPipelineId('');
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [loadPipelines, seedDefaultPipeline]);

  // Load stages + deals whenever selected pipeline changes.
  // Clearing on no-selection is a legitimate sync with URL/prop
  // state; the load completion uses async setters inside promise
  // callbacks (not synchronous in the effect body).
  useEffect(() => {
    if (!selectedPipelineId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setStages([]);
      setDeals([]);
      return;
    }
    let cancelled = false;
    (async () => {
      const [s, d] = await Promise.all([
        loadStages(selectedPipelineId),
        loadDeals(selectedPipelineId),
      ]);
      if (cancelled) return;
      setStages(s);
      setDeals(d);
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedPipelineId, loadStages, loadDeals]);

  const refreshPipelines = useCallback(async () => {
    const list = await loadPipelines();
    setPipelines(list);
    if (list.length === 0) setSelectedPipelineId('');
    else if (!list.some((p) => p.id === selectedPipelineId))
      setSelectedPipelineId(list[0].id);
  }, [loadPipelines, selectedPipelineId]);

  const refreshStages = useCallback(async () => {
    if (!selectedPipelineId) return;
    setStages(await loadStages(selectedPipelineId));
  }, [loadStages, selectedPipelineId]);

  const refreshDeals = useCallback(async () => {
    if (!selectedPipelineId) return;
    setDeals(await loadDeals(selectedPipelineId));
  }, [loadDeals, selectedPipelineId]);

  const handleDealMoved = useCallback(
    async (dealId: string, newStageId: string) => {
      const deal = deals.find((item) => item.id === dealId);
      const targetStage = stages.find((stage) => stage.id === newStageId);
      if (!deal || !targetStage) return;

      // A drag cannot collect missing required values. Open the normal deal
      // sheet with the destination selected so the user can supply them.
      const needsRequiredValues = (targetStage.custom_fields ?? []).some(
        (field) =>
          field.required &&
          (!deal.custom_values?.[field.id]?.trim() ||
            (field.type === 'dropdown' &&
              !(field.options ?? []).includes(
                deal.custom_values?.[field.id] ?? ''
              )))
      );
      if (needsRequiredValues) {
        setEditingDeal({ ...deal, stage_id: newStageId });
        setDefaultStageId(newStageId);
        setDealFormOpen(true);
        return;
      }

      // Optimistic update — board already animated; just persist.
      setDeals((prev) =>
        prev.map((d) => (d.id === dealId ? { ...d, stage_id: newStageId } : d))
      );
      const { error } = await supabase
        .from('deals')
        .update({ stage_id: newStageId })
        .eq('id', dealId);
      if (error) {
        toast.error(t('toastFailedMoveDeal'));
        refreshDeals();
      }
    },
    [deals, stages, supabase, refreshDeals, t]
  );

  const handleAddDeal = useCallback(
    (stageId?: string) => {
      setEditingDeal(null);
      setDefaultStageId(stageId ?? stages[0]?.id ?? '');
      setDealFormOpen(true);
    },
    [stages]
  );

  const handleEditDeal = useCallback((deal: Deal) => {
    setEditingDeal(deal);
    setDefaultStageId(deal.stage_id);
    setDealFormOpen(true);
  }, []);

  async function handleCreatePipeline() {
    const name = newPipelineName.trim();
    if (!name) return;
    setCreating(true);

    const {
      data: { session },
    } = await supabase.auth.getSession();
    const user = session?.user;
    if (!user) {
      setCreating(false);
      return;
    }
    // pipelines.account_id is NOT NULL post-017 with no DB default.
    if (!accountId) {
      toast.error(t('toastNotLinkedToAccount'));
      setCreating(false);
      return;
    }

    const { data: pipeline, error } = await supabase
      .from('pipelines')
      .insert({ user_id: user.id, account_id: accountId, name })
      .select()
      .single();

    if (error || !pipeline) {
      toast.error(t('toastFailedCreatePipeline'));
      setCreating(false);
      return;
    }

    const stagesPayload = SPEC_DEFAULT_STAGES.map((s) => ({
      pipeline_id: pipeline.id,
      name: s.name,
      color: s.color,
      position: s.position,
    }));
    await supabase.from('pipeline_stages').insert(stagesPayload);

    setNewPipelineName('');
    setNewPipelineOpen(false);
    setSelectedPipelineId(pipeline.id);
    await refreshPipelines();
    setCreating(false);
    toast.success(t('toastPipelineCreated'));
  }

  const selectedPipeline = pipelines.find((p) => p.id === selectedPipelineId);
  const filteredDeals = useMemo(() => {
    // A pipeline switch can render before its fetch completes. Keep the
    // previous pipeline's leads out of the transfer selection in that gap.
    const pipelineDeals = deals.filter(
      (deal) => deal.pipeline_id === selectedPipelineId
    );
    if (!canTransferDeals) return pipelineDeals;
    const from = dateFrom ? new Date(`${dateFrom}T00:00:00`).getTime() : null;
    const to = dateTo ? new Date(`${dateTo}T23:59:59.999`).getTime() : null;
    return pipelineDeals.filter((deal) => {
      const createdAt = new Date(deal.created_at).getTime();
      return (
        (from === null || createdAt >= from) &&
        (to === null || createdAt <= to) &&
        (selectedAgentIds.length === 0 ||
          selectedAgentIds.includes(deal.assigned_to ?? ''))
      );
    });
  }, [
    deals,
    selectedPipelineId,
    canTransferDeals,
    dateFrom,
    dateTo,
    selectedAgentIds,
  ]);

  // A change of account, pipeline or filters starts a fresh selection.
  const selectionScope = JSON.stringify([
    accountId,
    selectedPipelineId,
    dateFrom,
    dateTo,
    [...selectedAgentIds].sort(),
  ]);
  const bulkMode =
    canTransferDeals &&
    bulkSelection.enabled &&
    bulkSelection.scope === selectionScope;
  const bulkSourceId = bulkMode ? bulkSelection.sourceId : '';
  const stageIds = new Set(stages.map((stage) => stage.id));
  const boardDeals = filteredDeals.filter(
    (deal) =>
      stageIds.has(deal.stage_id) &&
      (!bulkSourceId || deal.assigned_to === bulkSourceId)
  );
  const selectedTransferDeals = bulkMode
    ? selectedBoardDeals(boardDeals, bulkSelection.dealIds, bulkSourceId)
    : [];
  const selectedTransferIds = new Set(
    selectedTransferDeals.map((deal) => deal.id)
  );

  function toggleBulkMode() {
    setBulkTransferOpen(false);
    setBulkSelection({
      scope: selectionScope,
      enabled: !bulkMode,
      sourceId:
        !bulkMode && selectedAgentIds.length === 1 ? selectedAgentIds[0] : '',
      dealIds: [],
    });
  }

  function handleBoardSelection(dealIds: string[], checked: boolean) {
    if (!bulkMode || !bulkSourceId) return;
    const eligibleIds = new Set(boardDeals.map((deal) => deal.id));
    const validIds = dealIds.filter((id) => eligibleIds.has(id));
    setBulkSelection((current) =>
      current.scope === selectionScope && current.sourceId === bulkSourceId
        ? {
            ...current,
            dealIds: updateDealSelection(
              current.dealIds.filter((id) => eligibleIds.has(id)),
              validIds,
              checked
            ),
          }
        : current
    );
  }

  async function handleBulkTransferred() {
    setBulkSelection((current) => ({ ...current, dealIds: [] }));
    await refreshDeals();
  }

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div className="bg-muted h-8 w-48 animate-pulse rounded" />
          <div className="bg-muted h-9 w-28 animate-pulse rounded-lg" />
        </div>
        <div className="flex gap-3">
          {[1, 2, 3, 4, 5].map((i) => (
            <div
              key={i}
              className="bg-muted/50 h-96 w-72 animate-pulse rounded-xl"
            />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          {/* Pipeline selector dropdown */}
          <DropdownMenu>
            <DropdownMenuTrigger className="border-border bg-card text-foreground hover:bg-muted data-[popup-open]:bg-muted inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors">
              <GitBranch className="text-primary h-4 w-4" />
              <span className="font-semibold">
                {selectedPipeline?.name ?? t('selectPipeline')}
              </span>
              <ChevronDown className="text-muted-foreground h-4 w-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              className="border-border bg-popover text-popover-foreground w-64"
            >
              {pipelines.length === 0 && (
                <DropdownMenuItem disabled className="text-muted-foreground">
                  {t('noPipelinesYet')}
                </DropdownMenuItem>
              )}
              {pipelines.map((p) => (
                <DropdownMenuItem
                  key={p.id}
                  onClick={() => setSelectedPipelineId(p.id)}
                  className={
                    p.id === selectedPipelineId
                      ? 'text-primary'
                      : 'text-popover-foreground'
                  }
                >
                  <GitBranch className="mr-2 h-3.5 w-3.5" />
                  {p.name}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator className="bg-border" />
              {selectedPipeline && (
                <DropdownMenuItem
                  onClick={() => setSettingsOpen(true)}
                  className="text-popover-foreground"
                >
                  <Settings className="mr-2 h-3.5 w-3.5" />
                  {t('managePipelines')}
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {canTransferDeals && (
            <Button
              variant={bulkMode ? 'default' : 'outline'}
              aria-pressed={bulkMode}
              disabled={
                !bulkMode &&
                (!selectedPipelineId ||
                  agents.length === 0 ||
                  filteredDeals.length === 0)
              }
              onClick={toggleBulkMode}
            >
              <ArrowRightLeft className="mr-1 h-4 w-4" />
              {bulkMode ? t('exitBulkTransfer') : t('bulkTransfer')}
            </Button>
          )}
          <GatedButton
            variant="outline"
            canAct={canEditSettings}
            gateReason="create pipelines"
            onClick={() => setNewPipelineOpen(true)}
            className="border-border bg-card text-foreground hover:bg-muted"
          >
            <Plus className="mr-1 h-4 w-4" />
            {t('addPipeline')}
          </GatedButton>
          <GatedButton
            canAct={canCreateDeals}
            gateReason="create deals"
            disabled={!selectedPipelineId || stages.length === 0}
            onClick={() => handleAddDeal()}
            className="bg-primary text-primary-foreground hover:bg-primary/90"
          >
            <Plus className="mr-1 h-4 w-4" />
            {t('addDeal')}
          </GatedButton>
        </div>
      </div>

      {canTransferDeals && pipelines.length > 0 && (
        <div className="border-border bg-card flex flex-wrap items-end gap-3 rounded-lg border p-3">
          <div className="grid gap-1">
            <Label htmlFor="deals-date-from" className="text-xs">
              {t('createdFrom')}
            </Label>
            <Input
              id="deals-date-from"
              type="date"
              value={dateFrom}
              max={dateTo || undefined}
              onChange={(e) => setDateFrom(e.target.value)}
              className="w-40"
            />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="deals-date-to" className="text-xs">
              {t('createdTo')}
            </Label>
            <Input
              id="deals-date-to"
              type="date"
              value={dateTo}
              min={dateFrom || undefined}
              onChange={(e) => setDateTo(e.target.value)}
              className="w-40"
            />
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger className="border-border hover:bg-muted inline-flex h-8 items-center gap-2 rounded-lg border px-3 text-sm">
              {selectedAgentIds.length === 0
                ? t('allAgents')
                : t('selectedAgents', { count: selectedAgentIds.length })}
              <ChevronDown className="h-4 w-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              className="max-h-64 w-56 overflow-y-auto"
            >
              {agents.map((agent) => (
                <DropdownMenuCheckboxItem
                  key={agent.id}
                  checked={selectedAgentIds.includes(agent.id)}
                  onCheckedChange={(checked) =>
                    setSelectedAgentIds((current) =>
                      checked
                        ? [...current, agent.id]
                        : current.filter((id) => id !== agent.id)
                    )
                  }
                >
                  {agent.full_name || agent.email}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          {(dateFrom || dateTo || selectedAgentIds.length > 0) && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setDateFrom('');
                setDateTo('');
                setSelectedAgentIds([]);
              }}
            >
              {t('clearFilters')}
            </Button>
          )}
        </div>
      )}

      {bulkMode && (
        <div className="border-primary/30 bg-primary/5 space-y-3 rounded-lg border p-3">
          <div className="flex flex-wrap items-end gap-3">
            <div className="grid gap-1">
              <Label htmlFor="bulk-transfer-source">
                {t('transferFromAgent')}
              </Label>
              <select
                id="bulk-transfer-source"
                value={bulkSourceId}
                className="border-input bg-background h-9 w-56 rounded-lg border px-3 text-sm"
                onChange={(event) =>
                  setBulkSelection({
                    scope: selectionScope,
                    enabled: true,
                    sourceId: event.target.value,
                    dealIds: [],
                  })
                }
              >
                <option value="">{t('chooseTransferAgent')}</option>
                {agents.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.full_name || agent.email}
                  </option>
                ))}
              </select>
            </div>
            <span
              aria-live="polite"
              className="text-muted-foreground py-2 text-sm"
            >
              {t('selectedForTransfer', {
                count: selectedTransferDeals.length,
              })}
            </span>
            <Button
              variant="ghost"
              disabled={selectedTransferDeals.length === 0}
              onClick={() =>
                setBulkSelection((current) => ({ ...current, dealIds: [] }))
              }
            >
              {t('clearSelection')}
            </Button>
            <Button
              className="sm:ml-auto"
              disabled={
                !bulkSourceId ||
                selectedTransferDeals.length === 0 ||
                selectedTransferDeals.length > 1000
              }
              onClick={() => setBulkTransferOpen(true)}
            >
              <ArrowRightLeft className="h-4 w-4" />
              {t('transferSelected')}
            </Button>
          </div>
          <p className="text-muted-foreground text-xs">
            {t('stageSelectionHint')}
          </p>
          {selectedTransferDeals.length > 1000 && (
            <p role="alert" className="text-destructive text-sm">
              {t('transferBatchLimit')}
            </p>
          )}
        </div>
      )}

      {/* Board */}
      {pipelines.length === 0 ? (
        <div className="border-border flex flex-col items-center justify-center rounded-xl border border-dashed py-20">
          <GitBranch className="text-muted-foreground h-12 w-12" />
          <h3 className="text-foreground mt-4 text-lg font-medium">
            {t('noPipelinesYet')}
          </h3>
          <p className="text-muted-foreground mt-2 text-sm">
            {t('createToStartTracking')}
          </p>
          <GatedButton
            canAct={canEditSettings}
            gateReason="create pipelines"
            onClick={() => setNewPipelineOpen(true)}
            className="bg-primary text-primary-foreground hover:bg-primary/90 mt-4"
          >
            <Plus className="mr-1 h-4 w-4" />
            {t('createPipeline')}
          </GatedButton>
        </div>
      ) : (
        <>
          <PipelineAnalytics stages={stages} deals={boardDeals} />
          <PipelineBoard
            stages={stages}
            deals={boardDeals}
            onDealMoved={handleDealMoved}
            onAddDeal={handleAddDeal}
            onEditDeal={handleEditDeal}
            selection={
              bulkMode
                ? {
                    selectedDealIds: selectedTransferIds,
                    canSelect: !!bulkSourceId,
                    onDealChecked: (id, checked) =>
                      handleBoardSelection([id], checked),
                    onStageChecked: (id, checked) =>
                      handleBoardSelection(
                        boardDeals
                          .filter((deal) => deal.stage_id === id)
                          .map((deal) => deal.id),
                        checked
                      ),
                  }
                : undefined
            }
          />
        </>
      )}

      {/* New Pipeline Dialog */}
      <Dialog open={newPipelineOpen} onOpenChange={setNewPipelineOpen}>
        <DialogContent className="bg-popover border-border sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-popover-foreground">
              {t('newPipeline')}
            </DialogTitle>
          </DialogHeader>
          <div className="py-2">
            <Label className="text-muted-foreground">{t('pipelineName')}</Label>
            <Input
              value={newPipelineName}
              onChange={(e) => setNewPipelineName(e.target.value)}
              placeholder={t('pipelineNamePlaceholder')}
              className="bg-muted border-border text-foreground mt-2"
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleCreatePipeline();
              }}
            />
            <p className="text-muted-foreground mt-2 text-xs">
              {t('defaultStagesDesc')}
            </p>
          </div>
          <DialogFooter className="bg-popover/50 border-border">
            <Button
              variant="outline"
              onClick={() => setNewPipelineOpen(false)}
              className="border-border text-muted-foreground hover:bg-muted"
            >
              {t('cancel')}
            </Button>
            <Button
              onClick={handleCreatePipeline}
              disabled={creating || !newPipelineName.trim()}
              className="bg-primary text-primary-foreground hover:bg-primary/90"
            >
              {creating ? t('creating') : t('createPipelineBtn')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Pipeline Settings */}
      {selectedPipeline && (
        <PipelineSettings
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
          pipeline={selectedPipeline}
          stages={stages}
          onPipelinesChanged={refreshPipelines}
          onStagesChanged={refreshStages}
          onCreateNewPipeline={() => {
            setSettingsOpen(false);
            setNewPipelineOpen(true);
          }}
        />
      )}

      {/* Deal Form (Sheet) */}
      {bulkTransferOpen && bulkMode && selectedTransferDeals.length > 0 && (
        <BulkTransferDialog
          key={`${accountId}:${selectedPipelineId}`}
          deals={selectedTransferDeals}
          agents={agents}
          sourceProfileId={bulkSourceId}
          onOpenChange={setBulkTransferOpen}
          onTransferred={handleBulkTransferred}
        />
      )}
      <DealForm
        open={dealFormOpen}
        onOpenChange={setDealFormOpen}
        deal={editingDeal}
        pipelineId={selectedPipelineId}
        stages={stages}
        defaultStageId={defaultStageId}
        onSaved={refreshDeals}
      />
    </div>
  );
}
