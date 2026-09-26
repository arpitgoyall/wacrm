'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { createClient } from '@/lib/supabase/client';
import {
  INBOX_CONVERSATION_SELECT,
  type InboxAttentionFilter,
  matchesAttentionFilter,
  matchesContactFilters,
  normalizeConversations,
} from '@/lib/inbox/conversations';
import { cn } from '@/lib/utils';
import type { Conversation, Pipeline, PipelineStage, Tag } from '@/types';
import { Search, ChevronDown, X } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { useTranslations } from 'next-intl';
import { Input } from '@/components/ui/input';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useAuth } from '@/hooks/use-auth';

interface ConversationListProps {
  activeConversationId: string | null;
  onSelect: (conversation: Conversation) => void;
  conversations: Conversation[];
  onConversationsLoaded: (conversations: Conversation[]) => void;
  onClearSelection?: () => void;
  /**
   * Increment to force the fetch effect below to refire. The parent
   * bumps this on realtime reconnect / tab visibility → visible so the
   * list catches up on any events sent while the WS was disconnected
   * or the tab was throttled. Optional so existing callers keep working.
   */
  resyncToken?: number;
}

interface DealStageLabel {
  name: string;
  color: string;
  pipelineId: string;
  pipelineIds: string[];
  stagesByPipeline: Record<string, { id: string; name: string; color: string }>;
}

export function ConversationList({
  activeConversationId,
  onSelect,
  conversations,
  onConversationsLoaded,
  onClearSelection,
  resyncToken = 0,
}: ConversationListProps) {
  const t = useTranslations('Inbox.conversationList');
  const { isOwner, isAdmin, account } = useAuth();
  const canViewAssignment = isOwner || isAdmin;

  const [search, setSearch] = useState('');
  const [attentionFilter, setAttentionFilter] =
    useState<InboxAttentionFilter>('all');
  const [assignmentFilter, setAssignmentFilter] = useState<'all' | 'unassigned'>('all');
  const [selectedPipelineId, setSelectedPipelineId] = useState<string>('');
  const [selectedStageId, setSelectedStageId] = useState<string>('all');
  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [pipelineStages, setPipelineStages] = useState<PipelineStage[]>([]);
  const [headerActionsTarget, setHeaderActionsTarget] =
    useState<HTMLElement | null>(null);
  const [loading, setLoading] = useState(true);
  // Contact-based filters (issue #272). Tags use OR logic (a conversation
  // matches if its contact carries any selected tag), consistent with
  // Broadcast audience filtering. Company is an exact match on the field.
  const [tags, setTags] = useState<Tag[]>([]);
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
  const [selectedCompany, setSelectedCompany] = useState<string | null>(null);
  const [agentNames, setAgentNames] = useState<Record<string, string>>({});
  const [dealStagesByContact, setDealStagesByContact] = useState<
    Record<string, DealStageLabel>
  >({});

  // Keep the latest callback in a ref so the fetch effect below can
  // have a stable, empty-dep identity. Previously the fetch useCallback
  // depended on `onConversationsLoaded`, which depends on the parent's
  // `deepLinkConvId` — so every URL change (including one the parent
  // triggered via router.replace after a click) caused a fresh
  // conversations fetch. That extra refetch was the trigger for the
  // deep-link auto-select running a second time and wiping the active
  // thread's messages.
  // Mutation lives in an effect (not render) per React 19's refs rule;
  // the fetch runs once on mount so it's fine to read the slightly
  // older value — the very next render updates the ref for any
  // subsequent async completion.
  const onConversationsLoadedRef = useRef(onConversationsLoaded);
  useEffect(() => {
    onConversationsLoadedRef.current = onConversationsLoaded;
  });

  useEffect(() => {
    // The dashboard header is outside the inbox page subtree. Portal the
    // owner-only selector into its dedicated action slot after hydration.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setHeaderActionsTarget(document.getElementById('page-header-actions'));
  }, []);

  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;

    (async () => {
      const { data, error } = await supabase
        .from('conversations')
        .select(INBOX_CONVERSATION_SELECT)
        .order('created_at', {
          referencedTable: 'latest_message',
          ascending: false,
        })
        .order('id', { referencedTable: 'latest_message', ascending: false })
        .limit(1, { referencedTable: 'latest_message' })
        .order('last_message_at', { ascending: false });

      if (cancelled) return;

      if (error) {
        // Supabase errors have non-enumerable properties — log fields explicitly
        console.error('Failed to fetch conversations:', {
          message: error.message,
          details: error.details,
          hint: error.hint,
          code: error.code,
        });
        setLoading(false);
        return;
      }

      onConversationsLoadedRef.current(normalizeConversations(data ?? []));
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
    // `resyncToken` is included so the parent can force a refetch when
    // the realtime channel reconnects or the tab regains focus — catches
    // up on any events sent while the WS was disconnected or throttled.
  }, [resyncToken]);

  useEffect(() => {
    if (!isOwner) return;
    const supabase = createClient();
    let cancelled = false;
    void supabase
      .from('pipelines')
      .select('*')
      .order('name')
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) {
          console.error('Failed to fetch inbox pipelines:', error);
          return;
        }
        const rows = (data as Pipeline[] | null) ?? [];
        setPipelines(rows);
        const salesPipeline =
          rows.find((pipeline) => pipeline.id === account?.sales_pipeline_id) ??
          rows.find((pipeline) => /sales/i.test(pipeline.name)) ??
          rows[0];
        setSelectedPipelineId((current) => current || salesPipeline?.id || '');
      });
    return () => {
      cancelled = true;
    };
  }, [isOwner, account?.sales_pipeline_id]);

  useEffect(() => {
    if (!isOwner || !selectedPipelineId) return;
    const supabase = createClient();
    let cancelled = false;
    void supabase
      .from('pipeline_stages')
      .select('id, pipeline_id, name, position, color, created_at')
      .eq('pipeline_id', selectedPipelineId)
      .order('position')
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) {
          console.error('Failed to fetch inbox pipeline stages:', error);
          return;
        }
        setPipelineStages((data as PipelineStage[] | null) ?? []);
      });
    return () => {
      cancelled = true;
    };
  }, [isOwner, selectedPipelineId]);

  // Show the most recent open deal's pipeline stage for each contact. Deals
  // created from the inbox are contact-linked, so contact_id is the reliable
  // bridge even for older rows whose optional conversation_id is null.
  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;

    async function loadDealStages() {
      const { data, error } = await supabase
        .from('deals')
        .select(
          'contact_id, pipeline_id, stage_id, created_at, stage:pipeline_stages(name, color)'
        )
        .eq('status', 'open')
        .order('created_at', { ascending: false });

      if (cancelled) return;
      if (error) {
        console.error('Failed to fetch inbox deal stages:', error);
        return;
      }

      const next: Record<string, DealStageLabel> = {};
      for (const row of (data ?? []) as unknown as Array<{
        contact_id: string | null;
        pipeline_id: string;
        stage_id: string;
        stage: DealStageLabel | null;
      }>) {
        if (!row.contact_id || !row.stage) continue;
        if (!next[row.contact_id]) {
          next[row.contact_id] = {
            ...row.stage,
            pipelineId: row.pipeline_id,
            pipelineIds: [row.pipeline_id],
            stagesByPipeline: {
              [row.pipeline_id]: {
                id: row.stage_id,
                name: row.stage.name,
                color: row.stage.color,
              },
            },
          };
        } else if (
          !next[row.contact_id].pipelineIds.includes(row.pipeline_id)
        ) {
          next[row.contact_id].pipelineIds.push(row.pipeline_id);
          next[row.contact_id].stagesByPipeline[row.pipeline_id] = {
            id: row.stage_id,
            name: row.stage.name,
            color: row.stage.color,
          };
        }
      }
      setDealStagesByContact(next);
    }

    void loadDealStages();
    const channel = supabase
      .channel('inbox-deal-stages')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'deals' },
        () => void loadDealStages()
      )
      .subscribe();

    return () => {
      cancelled = true;
      void supabase.removeChannel(channel);
    };
  }, [resyncToken]);

  // Tag definitions for the filter picker — loaded once so labels/colours
  // stay stable regardless of which conversations happen to be loaded.
  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;
    (async () => {
      const { data } = await supabase.from('tags').select('*').order('name');
      if (!cancelled && data) setTags(data as Tag[]);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;

    (async () => {
      const { data } = await supabase
        .from('profiles')
        .select('user_id, full_name, email')
        .order('full_name');
      if (cancelled || !data) return;

      const names: Record<string, string> = {};
      for (const profile of data as {
        user_id: string;
        full_name: string | null;
        email: string | null;
      }[]) {
        names[profile.user_id] =
          profile.full_name || profile.email || profile.user_id;
      }
      setAgentNames(names);
    })();

    return () => {
      cancelled = true;
    };
  }, [resyncToken]);

  // Company options are derived from the loaded conversations — there's no
  // separate companies table, and only companies with a live conversation
  // are worth offering as an inbox filter.
  const companies = useMemo(() => {
    const set = new Set<string>();
    for (const c of conversations) {
      const co = c.contact?.company?.trim();
      if (co) set.add(co);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [conversations]);

  const tagsById = useMemo(() => {
    const m = new Map<string, Tag>();
    for (const t of tags) m.set(t.id, t);
    return m;
  }, [tags]);

  const filtered = useMemo(() => {
    let result = conversations;

    if (attentionFilter !== 'all') {
      result = result.filter((conversation) =>
        matchesAttentionFilter(conversation, attentionFilter)
      );
    }

    if (isOwner && assignmentFilter === 'unassigned') {
      result = result.filter((conversation) => !conversation.assigned_agent_id);
    }

    // "All" stages means no deal-stage restriction at all, so contacts
    // without a deal remain visible. A deal is required only when the user
    // selects one specific stage.
    if (isOwner && selectedPipelineId && selectedStageId !== 'all') {
      result = result.filter((conversation) => {
        const contactId = conversation.contact?.id;
        const pipelineStage = contactId
          ? dealStagesByContact[contactId]?.stagesByPipeline[selectedPipelineId]
          : undefined;
        return (
          !!contactId && !!pipelineStage && pipelineStage.id === selectedStageId
        );
      });
    }

    // Contact-based filters (tags via OR logic, exact company match).
    if (selectedTagIds.length > 0 || selectedCompany !== null) {
      result = result.filter((c) =>
        matchesContactFilters(c, {
          tagIds: selectedTagIds,
          company: selectedCompany,
        })
      );
    }

    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter((c) => {
        const name = c.contact?.name?.toLowerCase() ?? '';
        const phone = c.contact?.phone?.toLowerCase() ?? '';
        const lastMsg = c.last_message_text?.toLowerCase() ?? '';
        return name.includes(q) || phone.includes(q) || lastMsg.includes(q);
      });
    }

    return result;
  }, [
    conversations,
    attentionFilter,
    assignmentFilter,
    search,
    selectedTagIds,
    selectedCompany,
    isOwner,
    selectedPipelineId,
    selectedStageId,
    dealStagesByContact,
  ]);

  const toggleTag = useCallback((id: string) => {
    setSelectedTagIds((prev) =>
      prev.includes(id) ? prev.filter((t) => t !== id) : [...prev, id]
    );
  }, []);

  const clearContactFilters = useCallback(() => {
    setSelectedTagIds([]);
    setSelectedCompany(null);
  }, []);

  const hasContactFilters =
    selectedTagIds.length > 0 || selectedCompany !== null;

  const handleSearchChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setSearch(e.target.value);
    },
    []
  );

  const handleSelect = useCallback(
    (conv: Conversation) => {
      onSelect(conv);
    },
    [onSelect]
  );

  const activePipeline = pipelines.find(
    (pipeline) => pipeline.id === selectedPipelineId
  );
  const activeStage = pipelineStages.find(
    (stage) => stage.id === selectedStageId
  );
  const attentionFilterLabel =
    attentionFilter === 'unread'
      ? t('filterUnread')
      : attentionFilter === 'awaiting_reply'
        ? t('filterAwaitingReply')
        : t('filterAll');

  const handlePipelineChange = useCallback(
    (pipelineId: string) => {
      setSelectedPipelineId(pipelineId);
      setSelectedStageId('all');
      onClearSelection?.();
    },
    [onClearSelection]
  );

  return (
    // w-full on mobile so the list occupies the whole viewport when it's
    // the single pane showing; fixed 320px on desktop where it shares the
    // row with the thread + contact sidebar.
    <div className="border-border bg-card flex h-full w-full flex-col border-r lg:w-80">
      {headerActionsTarget && isOwner && pipelines.length > 0
        ? createPortal(
            <DropdownMenu>
              <DropdownMenuTrigger className="border-border bg-muted/50 text-foreground hover:bg-muted inline-flex h-8 max-w-48 items-center justify-center gap-1 rounded-md border px-2.5 text-xs">
                <span className="truncate">
                  {activePipeline?.name ?? pipelines[0]?.name}
                </span>
                <ChevronDown className="text-muted-foreground h-3.5 w-3.5 shrink-0" />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="border-border bg-popover max-h-64 w-56"
              >
                {pipelines.map((pipeline) => (
                  <DropdownMenuItem
                    key={pipeline.id}
                    onClick={() => handlePipelineChange(pipeline.id)}
                    className={cn(
                      'text-sm',
                      selectedPipelineId === pipeline.id
                        ? 'text-primary'
                        : 'text-popover-foreground'
                    )}
                  >
                    {pipeline.name}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>,
            headerActionsTarget
          )
        : null}
      {/* Search + Filter */}
      <div className="border-border space-y-2 border-b p-3">
        <div className="relative">
          <Search className="text-muted-foreground absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2" />
          <Input
            value={search}
            onChange={handleSearchChange}
            placeholder={t('searchPlaceholder')}
            className="border-border bg-muted text-foreground placeholder-muted-foreground focus:border-primary/50 pl-9 text-sm"
          />
        </div>

        <div className="flex flex-wrap items-center gap-1">
          <DropdownMenu>
            <DropdownMenuTrigger
              className={cn(
                'hover:bg-muted inline-flex h-7 items-center justify-center gap-1 rounded-md px-2 text-xs',
                attentionFilter === 'all'
                  ? 'text-muted-foreground hover:text-foreground'
                  : 'text-primary'
              )}
            >
              {attentionFilterLabel}
              <ChevronDown className="h-3 w-3" />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              className="border-border bg-popover w-44"
            >
              {(['all', 'unread', 'awaiting_reply'] as const).map((filter) => (
                <DropdownMenuItem
                  key={filter}
                  onClick={() => {
                    setAttentionFilter(filter);
                    onClearSelection?.();
                  }}
                  className={cn(
                    'text-sm',
                    attentionFilter === filter
                      ? 'text-primary'
                      : 'text-popover-foreground'
                  )}
                >
                  {filter === 'all'
                    ? t('filterAll')
                    : filter === 'unread'
                      ? t('filterUnread')
                      : t('filterAwaitingReply')}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          {isOwner && (
            <DropdownMenu>
              <DropdownMenuTrigger
                className={cn(
                  'hover:bg-muted inline-flex h-7 items-center justify-center gap-1 rounded-md px-2 text-xs',
                  assignmentFilter === 'all'
                    ? 'text-muted-foreground hover:text-foreground'
                    : 'text-primary'
                )}
              >
                {assignmentFilter === 'all' ? t('allChats') : t('unassigned')}
                <ChevronDown className="h-3 w-3" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="border-border bg-popover w-44">
                {(['all', 'unassigned'] as const).map((filter) => (
                  <DropdownMenuItem
                    key={filter}
                    onClick={() => {
                      setAssignmentFilter(filter);
                      onClearSelection?.();
                    }}
                    className={cn(
                      'text-sm',
                      assignmentFilter === filter
                        ? 'text-primary'
                        : 'text-popover-foreground'
                    )}
                  >
                    {filter === 'all' ? t('allChats') : t('unassigned')}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}

          {tags.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger
                className={cn(
                  'hover:bg-muted inline-flex h-7 items-center justify-center gap-1 rounded-md px-2 text-xs',
                  selectedTagIds.length > 0
                    ? 'text-primary'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {t('tags')}
                {selectedTagIds.length > 0 && (
                  <span className="bg-primary text-primary-foreground flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-bold">
                    {selectedTagIds.length}
                  </span>
                )}
                <ChevronDown className="h-3 w-3" />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="border-border bg-popover max-h-64 w-56"
              >
                {tags.map((t) => (
                  <DropdownMenuCheckboxItem
                    key={t.id}
                    checked={selectedTagIds.includes(t.id)}
                    onCheckedChange={() => toggleTag(t.id)}
                    className="text-popover-foreground text-sm"
                  >
                    <span className="flex items-center gap-2">
                      <span
                        className="h-2 w-2 shrink-0 rounded-full"
                        style={{ backgroundColor: t.color }}
                      />
                      <span className="truncate">{t.name}</span>
                    </span>
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}

          {isOwner && selectedPipelineId && pipelineStages.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger className="text-muted-foreground hover:bg-muted hover:text-foreground inline-flex h-7 max-w-36 items-center justify-center gap-1 rounded-md px-2 text-xs">
                <span className="truncate">
                  {activeStage?.name ?? t('allStages')}
                </span>
                <ChevronDown className="h-3 w-3 shrink-0" />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="border-border bg-popover max-h-64 w-56"
              >
                <DropdownMenuItem
                  onClick={() => {
                    setSelectedStageId('all');
                    onClearSelection?.();
                  }}
                  className={cn(
                    'text-sm',
                    selectedStageId === 'all'
                      ? 'text-primary'
                      : 'text-popover-foreground'
                  )}
                >
                  {t('allStages')}
                </DropdownMenuItem>
                {pipelineStages.map((stage) => (
                  <DropdownMenuItem
                    key={stage.id}
                    onClick={() => {
                      setSelectedStageId(stage.id);
                      onClearSelection?.();
                    }}
                    className={cn(
                      'text-sm',
                      selectedStageId === stage.id
                        ? 'text-primary'
                        : 'text-popover-foreground'
                    )}
                  >
                    <span
                      className="h-2 w-2 shrink-0 rounded-full"
                      style={{ backgroundColor: stage.color }}
                    />
                    {stage.name}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}

          {companies.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger
                className={cn(
                  'hover:bg-muted inline-flex h-7 max-w-40 items-center justify-center gap-1 rounded-md px-2 text-xs',
                  selectedCompany
                    ? 'text-primary'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                <span className="truncate">
                  {selectedCompany ?? t('company')}
                </span>
                <ChevronDown className="h-3 w-3 shrink-0" />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="border-border bg-popover max-h-64 w-56"
              >
                <DropdownMenuItem
                  onClick={() => setSelectedCompany(null)}
                  className={cn(
                    'text-sm',
                    selectedCompany === null
                      ? 'text-primary'
                      : 'text-popover-foreground'
                  )}
                >
                  {t('allCompanies')}
                </DropdownMenuItem>
                {companies.map((co) => (
                  <DropdownMenuItem
                    key={co}
                    onClick={() => setSelectedCompany(co)}
                    className={cn(
                      'text-sm',
                      selectedCompany === co
                        ? 'text-primary'
                        : 'text-popover-foreground'
                    )}
                  >
                    <span className="truncate">{co}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>

        {hasContactFilters && (
          <div className="flex flex-wrap items-center gap-1">
            {selectedTagIds.map((id) => {
              const tag = tagsById.get(id);
              return (
                <button
                  key={id}
                  onClick={() => toggleTag(id)}
                  className="bg-muted text-foreground hover:bg-muted/70 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px]"
                >
                  <span
                    className="h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{
                      backgroundColor: tag?.color ?? 'var(--muted-foreground)',
                    }}
                  />
                  <span className="max-w-24 truncate">
                    {tag?.name ?? t('tags')}
                  </span>
                  <X className="h-3 w-3" />
                </button>
              );
            })}
            {selectedCompany && (
              <button
                onClick={() => setSelectedCompany(null)}
                className="bg-muted text-foreground hover:bg-muted/70 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px]"
              >
                <span className="max-w-24 truncate">{selectedCompany}</span>
                <X className="h-3 w-3" />
              </button>
            )}
            <button
              onClick={clearContactFilters}
              className="text-muted-foreground hover:text-foreground px-1 text-[11px]"
            >
              {t('clearAll')}
            </button>
          </div>
        )}
      </div>

      {/* Conversation Items.
          `min-h-0` is load-bearing: a flex child defaults to
          min-height:auto, so without it this ScrollArea grows to fit
          every conversation instead of shrinking to the remaining
          space — the list then overflows and gets clipped by the
          parent's overflow-hidden with no scrollbar (issue #229). */}
      <ScrollArea className="min-h-0 flex-1">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <div className="border-primary h-5 w-5 animate-spin rounded-full border-2 border-t-transparent" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="px-4 py-12 text-center">
            <p className="text-muted-foreground text-sm">
              {t('noConversations')}
            </p>
          </div>
        ) : (
          <div className="flex flex-col">
            {filtered.map((conv) => (
              <ConversationItem
                key={conv.id}
                conversation={conv}
                isActive={conv.id === activeConversationId}
                onSelect={handleSelect}
                assigneeName={
                  conv.assigned_agent_id
                    ? agentNames[conv.assigned_agent_id]
                    : undefined
                }
                dealStage={
                  conv.contact?.id
                    ? selectedPipelineId
                      ? dealStagesByContact[conv.contact.id]?.stagesByPipeline[
                          selectedPipelineId
                        ]
                      : dealStagesByContact[conv.contact.id]
                    : undefined
                }
                showAssignee={canViewAssignment}
                t={t}
              />
            ))}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}

interface ConversationItemProps {
  conversation: Conversation;
  isActive: boolean;
  onSelect: (conversation: Conversation) => void;
  assigneeName?: string;
  dealStage?: Pick<DealStageLabel, 'name' | 'color'>;
  showAssignee: boolean;
  t: ReturnType<typeof useTranslations>;
}

function ConversationItem({
  conversation,
  isActive,
  onSelect,
  assigneeName,
  dealStage,
  showAssignee,
  t,
}: ConversationItemProps) {
  const contact = conversation.contact;
  const displayName = contact?.name || contact?.phone || t('unknown');
  const initials = displayName.charAt(0).toUpperCase();

  const handleClick = useCallback(() => {
    onSelect(conversation);
  }, [onSelect, conversation]);

  const timeAgo = conversation.last_message_at
    ? formatDistanceToNow(new Date(conversation.last_message_at), {
        addSuffix: false,
      })
    : '';

  return (
    <button
      onClick={handleClick}
      className={cn(
        'hover:bg-muted/50 flex w-full items-start gap-3 px-3 py-3 text-left transition-colors',
        isActive && 'border-primary bg-muted/70 border-l-2'
      )}
    >
      {/* Avatar */}
      <div className="bg-muted text-foreground flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-sm font-medium">
        {contact?.avatar_url ? (
          <img
            src={contact.avatar_url}
            alt={displayName}
            className="h-10 w-10 rounded-full object-cover"
          />
        ) : (
          initials
        )}
      </div>

      {/* Content */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span className="text-foreground min-w-0 flex-1 truncate text-sm font-medium">
            {displayName}
          </span>
          <span className="text-muted-foreground shrink-0 text-[10px]">
            {timeAgo}
          </span>
        </div>
        <div className="mt-0.5 flex items-center justify-between gap-2">
          <p className="text-muted-foreground min-w-0 flex-1 truncate text-xs">
            {conversation.last_message_text || t('noMessagesYet')}
          </p>
          <div className="flex shrink-0 items-center gap-1.5">
            {conversation.unread_count > 0 && (
              <span className="bg-primary text-primary-foreground flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-bold">
                {conversation.unread_count}
              </span>
            )}
            {dealStage && (
              <span
                className="max-w-24 truncate rounded-full px-2 py-0.5 text-[10px] font-medium"
                style={{
                  backgroundColor: `${dealStage.color}20`,
                  color: dealStage.color,
                }}
                title={dealStage.name}
              >
                {dealStage.name}
              </span>
            )}
          </div>
        </div>
        {showAssignee && assigneeName && (
          <p className="text-muted-foreground mt-1 truncate text-[10px]">
            {t('assignedTo', { name: assigneeName })}
          </p>
        )}
      </div>
    </button>
  );
}
