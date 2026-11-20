'use client';

import { useEffect, useMemo, useState } from 'react';
import { Target } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { DEFAULT_QUALIFICATION_CRITERIA } from '@/lib/ai/defaults';

export interface QualificationState {
  pipelineId: string;
  stageQualifiedId: string;
  stageLostId: string;
  stageNotRespondingId: string;
  stageFollowUpId: string;
  criteria: string;
}

export const DEFAULT_QUALIFICATION: QualificationState = {
  pipelineId: '',
  stageQualifiedId: '',
  stageLostId: '',
  stageNotRespondingId: '',
  stageFollowUpId: '',
  criteria: '',
};

export function qualificationFromApi(
  data: Record<string, unknown>
): QualificationState {
  const s = (v: unknown) => (typeof v === 'string' ? v : '');
  return {
    pipelineId: s(data.qualification_pipeline_id),
    stageQualifiedId: s(data.stage_qualified_id),
    stageLostId: s(data.stage_lost_id),
    stageNotRespondingId: s(data.stage_not_responding_id),
    stageFollowUpId: s(data.stage_follow_up_id),
    criteria: s(data.qualification_criteria),
  };
}

export function qualificationToApi(q: QualificationState) {
  return {
    qualification_pipeline_id: q.pipelineId || null,
    stage_qualified_id: q.stageQualifiedId || null,
    stage_lost_id: q.stageLostId || null,
    stage_not_responding_id: q.stageNotRespondingId || null,
    stage_follow_up_id: q.stageFollowUpId || null,
    qualification_criteria: q.criteria.trim() || null,
  };
}

interface PipelineRow {
  id: string;
  name: string;
}
interface StageRow {
  id: string;
  pipeline_id: string;
  name: string;
  position: number;
}

// Radix Select can't hold an empty value, so "don't move" gets a sentinel.
const NONE = '__none__';

const STAGE_FIELDS: {
  key: keyof QualificationState;
  label: string;
  hint: string;
  guess: string;
}[] = [
  {
    key: 'stageQualifiedId',
    label: 'When qualified',
    hint: 'Also assigns a counsellor and fires your assigned automation.',
    guess: 'qualified',
  },
  {
    key: 'stageFollowUpId',
    label: 'When they raise an objection',
    hint: 'Price, timing, “will think” — the AI keeps going.',
    guess: 'follow up',
  },
  {
    key: 'stageNotRespondingId',
    label: 'When they stop replying',
    hint: 'After a nudge, once the 24-hour window closes unanswered.',
    guess: 'not responding',
  },
  {
    key: 'stageLostId',
    label: 'When they clearly say no',
    hint: '“Not interested”, “stop”, wrong number. Never on price alone.',
    guess: 'lost',
  },
];

export function AiQualificationCard({
  accountId,
  value,
  onChange,
  disabled,
}: {
  accountId: string | null;
  value: QualificationState;
  onChange: (next: QualificationState) => void;
  disabled: boolean;
}) {
  const [pipelines, setPipelines] = useState<PipelineRow[]>([]);
  const [stages, setStages] = useState<StageRow[]>([]);

  useEffect(() => {
    if (!accountId) return;
    const supabase = createClient();
    let cancelled = false;
    void Promise.all([
      supabase
        .from('pipelines')
        .select('id, name')
        .eq('account_id', accountId)
        .order('name'),
      supabase
        .from('pipeline_stages')
        .select('id, pipeline_id, name, position')
        .order('position'),
    ]).then(([p, s]) => {
      if (cancelled) return;
      setPipelines((p.data as PipelineRow[] | null) ?? []);
      setStages((s.data as StageRow[] | null) ?? []);
    });
    return () => {
      cancelled = true;
    };
  }, [accountId]);

  const pipelineStages = useMemo(
    () => stages.filter((s) => s.pipeline_id === value.pipelineId),
    [stages, value.pipelineId]
  );

  // Picking a pipeline pre-selects stages whose names match the usual ones.
  const choosePipeline = (pipelineId: string) => {
    const own = stages.filter((s) => s.pipeline_id === pipelineId);
    const next: QualificationState = { ...value, pipelineId };
    for (const f of STAGE_FIELDS) {
      const match = own.find((s) => s.name.trim().toLowerCase() === f.guess);
      (next[f.key] as string) = match?.id ?? '';
    }
    onChange(next);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Target className="text-primary h-4 w-4" /> Lead qualification
        </CardTitle>
        <CardDescription>
          The AI&apos;s goal is to qualify leads. It builds a lead card (name,
          what they do, goal, objection…) as it chats, saves it as a contact
          note, and moves the lead&apos;s deal in the pipeline below. It only
          moves leads forward and never touches a deal your team has already
          taken to Qualified or beyond.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label>Pipeline</Label>
          <Select
            value={value.pipelineId || NONE}
            onValueChange={(v) =>
              !v || v === NONE
                ? onChange({ ...DEFAULT_QUALIFICATION, criteria: value.criteria })
                : choosePipeline(v)
            }
            disabled={disabled}
          >
            <SelectTrigger className="w-full min-w-0">
              {/* Base UI shows the raw value (an id) unless given a label. */}
              <SelectValue>
                {pipelines.find((p) => p.id === value.pipelineId)?.name ??
                  (value.pipelineId ? 'Loading…' : 'Don’t move deals')}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>Don&apos;t move deals</SelectItem>
              {pipelines.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {value.pipelineId && (
          <div className="grid gap-4 sm:grid-cols-2">
            {STAGE_FIELDS.map((f) => (
              <div key={f.key} className="min-w-0 space-y-1">
                <Label className="text-xs">{f.label}</Label>
                <Select
                  value={(value[f.key] as string) || NONE}
                  onValueChange={(v) =>
                    onChange({ ...value, [f.key]: !v || v === NONE ? '' : v })
                  }
                  disabled={disabled}
                >
                  <SelectTrigger className="w-full min-w-0">
                    <SelectValue>
                      {pipelineStages.find((s) => s.id === value[f.key])?.name ??
                        (value[f.key] ? 'Loading…' : 'Don’t move')}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>Don&apos;t move</SelectItem>
                    {pipelineStages.map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        {s.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-muted-foreground text-xs">{f.hint}</p>
              </div>
            ))}
          </div>
        )}

        <div className="space-y-2">
          <Label htmlFor="ai-qual-criteria">
            What counts as qualified?{' '}
            <span className="text-muted-foreground font-normal">
              (optional — leave empty for the default)
            </span>
          </Label>
          <Textarea
            id="ai-qual-criteria"
            value={value.criteria}
            onChange={(e) => onChange({ ...value, criteria: e.target.value })}
            placeholder={DEFAULT_QUALIFICATION_CRITERIA}
            rows={4}
            disabled={disabled}
          />
        </div>
      </CardContent>
    </Card>
  );
}
