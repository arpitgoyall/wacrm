import { describe, expect, it } from 'vitest';
import type { Deal } from '@/types';
import { selectedBoardDeals, updateDealSelection } from './deal-selection';

function deal(id: string, stageId = 'qualified', agent = 'source'): Deal {
  return {
    id,
    stage_id: stageId,
    assigned_to: agent,
    pipeline_id: 'pipeline',
    user_id: 'creator',
    contact_id: id,
    title: id,
    value: 0,
    created_at: '',
  };
}

describe('board lead selection', () => {
  it('combines a whole stage with individually selected leads from another stage', () => {
    const rows = [
      deal('a'),
      deal('b'),
      deal('c', 'proposal'),
      deal('d', 'proposal'),
    ];
    let ids = updateDealSelection(
      [],
      rows.filter((row) => row.stage_id === 'qualified').map((row) => row.id),
      true
    );
    ids = updateDealSelection(ids, ['c'], true);
    expect(
      selectedBoardDeals(rows, ids, 'source').map((row) => row.id)
    ).toEqual(['a', 'b', 'c']);
  });

  it('unchecking a stage keeps selections in other stages', () => {
    const ids = updateDealSelection(['a', 'b', 'c'], ['a', 'b'], false);
    expect(ids).toEqual(['c']);
  });

  it('reselecting a partially selected stage does not duplicate leads', () => {
    expect(updateDealSelection(['a', 'c'], ['a', 'b'], true)).toEqual([
      'a',
      'c',
      'b',
    ]);
  });

  it('excludes leads hidden by filters or reassigned to another agent', () => {
    const visible = [deal('visible'), deal('reassigned', 'qualified', 'other')];
    expect(
      selectedBoardDeals(
        visible,
        ['visible', 'hidden', 'reassigned'],
        'source'
      ).map((row) => row.id)
    ).toEqual(['visible']);
  });

  it('does not silently trim a stage containing more than the batch limit', () => {
    const ids = Array.from({ length: 1001 }, (_, index) => `deal-${index}`);
    expect(updateDealSelection([], ids, true)).toHaveLength(1001);
  });
});
