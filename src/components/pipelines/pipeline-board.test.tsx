import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';
import messages from '../../../messages/en.json';
import type { Deal, PipelineStage } from '@/types';

vi.mock('@/hooks/use-auth', () => ({
  useAuth: () => ({ defaultCurrency: 'USD' }),
}));
vi.mock('@/components/created-age', () => ({ CreatedAge: () => null }));

import { PipelineBoard } from './pipeline-board';

const stages: PipelineStage[] = [
  {
    id: 'qualified',
    pipeline_id: 'pipeline',
    name: 'Qualified',
    color: '#fff',
    position: 0,
    created_at: '',
  },
  {
    id: 'proposal',
    pipeline_id: 'pipeline',
    name: 'Proposal',
    color: '#fff',
    position: 1,
    created_at: '',
  },
  {
    id: 'empty',
    pipeline_id: 'pipeline',
    name: 'Empty',
    color: '#fff',
    position: 2,
    created_at: '',
  },
];
const deals: Deal[] = ['a', 'b', 'c'].map((id, index) => ({
  id,
  pipeline_id: 'pipeline',
  stage_id: index < 2 ? 'qualified' : 'proposal',
  assigned_to: 'source',
  user_id: 'creator',
  contact_id: null,
  title: `Lead ${id}`,
  value: 0,
  created_at: '',
}));

function render(selectedIds?: string[], canSelect = true) {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={messages}>
      <PipelineBoard
        stages={stages}
        deals={deals}
        onDealMoved={vi.fn()}
        onAddDeal={vi.fn()}
        onEditDeal={vi.fn()}
        selection={
          selectedIds
            ? {
                selectedDealIds: new Set(selectedIds),
                canSelect,
                onDealChecked: vi.fn(),
                onStageChecked: vi.fn(),
              }
            : undefined
        }
      />
    </NextIntlClientProvider>
  );
}

function checkbox(html: string, label: string) {
  const tag = html.match(new RegExp(`<[^>]+aria-label="${label}"[^>]*>`))?.[0];
  expect(tag, `Missing checkbox: ${label}`).toBeDefined();
  return tag!;
}

describe('pipeline board bulk transfer controls', () => {
  it('shows a checkbox on every deal and every stage only in transfer mode', () => {
    const normal = render();
    expect(normal).not.toContain('Select all leads in');
    expect(normal).not.toContain('Select Lead a for transfer');
    const selection = render([]);
    for (const stage of stages)
      checkbox(selection, `Select all leads in ${stage.name}`);
    for (const deal of deals)
      checkbox(selection, `Select ${deal.title} for transfer`);
  });

  it('shows a partially selected column as indeterminate and a fully selected column as checked', () => {
    const html = render(['a', 'c']);
    expect(checkbox(html, 'Select all leads in Qualified')).toContain(
      'aria-checked="mixed"'
    );
    expect(checkbox(html, 'Select all leads in Proposal')).toContain(
      'aria-checked="true"'
    );
    expect(checkbox(html, 'Select all leads in Empty')).toContain(
      'aria-disabled="true"'
    );
  });

  it('disables selection until a sending agent is chosen', () => {
    const html = render([], false);
    expect(checkbox(html, 'Select all leads in Qualified')).toContain(
      'aria-disabled="true"'
    );
    expect(checkbox(html, 'Select Lead a for transfer')).toContain(
      'aria-disabled="true"'
    );
  });
});
