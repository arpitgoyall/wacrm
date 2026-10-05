import type { Deal } from '@/types';

export function updateDealSelection(
  selectedIds: readonly string[],
  dealIds: readonly string[],
  checked: boolean
): string[] {
  const next = new Set(selectedIds);
  for (const id of dealIds) {
    if (checked) next.add(id);
    else next.delete(id);
  }
  return [...next];
}

// The visible, eligible board rows are the authority for a transfer. Hidden
// selections and leads reassigned to another agent must never enter the RPC.
export function selectedBoardDeals(
  visibleDeals: readonly Deal[],
  selectedIds: readonly string[],
  sourceProfileId: string
): Deal[] {
  const ids = new Set(selectedIds);
  return visibleDeals.filter(
    (deal) => ids.has(deal.id) && deal.assigned_to === sourceProfileId
  );
}
