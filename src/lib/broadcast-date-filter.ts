/**
 * "Contact added between" filter for broadcast audiences.
 *
 * It narrows whatever the primary audience picked (all / tags / stages /
 * custom field) — an AND, not another audience type — so "tag = Drone
 * AND added before 16 Nov" works. CSV audiences are hand-picked lists,
 * so the date filter doesn't apply to them.
 *
 * Dates are `YYYY-MM-DD` strings from <input type="date">, read as whole
 * days in the browser's local time zone: `from` is inclusive from 00:00,
 * `to` is inclusive through 23:59:59.999 (stored as an exclusive bound
 * at the next midnight).
 */

export interface CreatedDateFilter {
  /** Inclusive start day, `YYYY-MM-DD`. */
  createdFrom?: string;
  /** Inclusive end day, `YYYY-MM-DD`. */
  createdTo?: string;
}

export interface CreatedRange {
  /** ISO timestamp, inclusive. */
  gte?: string;
  /** ISO timestamp, exclusive. */
  lt?: string;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function localMidnight(day: string): Date | null {
  if (!DAY_RE.test(day)) return null;
  const [y, m, d] = day.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  // Reject rollovers like 2026-02-31 → 3 Mar.
  if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) {
    return null;
  }
  return date;
}

/** Converts the picked days into created_at bounds; null when unset. */
export function createdRange(filter: CreatedDateFilter): CreatedRange | null {
  const from = filter.createdFrom ? localMidnight(filter.createdFrom) : null;
  const toDay = filter.createdTo ? localMidnight(filter.createdTo) : null;
  if (!from && !toDay) return null;

  const range: CreatedRange = {};
  if (from) range.gte = from.toISOString();
  if (toDay) {
    const next = new Date(toDay);
    next.setDate(next.getDate() + 1);
    range.lt = next.toISOString();
  }
  return range;
}

/** True when the picked days are in the wrong order. */
export function isCreatedRangeInverted(filter: CreatedDateFilter): boolean {
  const from = filter.createdFrom ? localMidnight(filter.createdFrom) : null;
  const to = filter.createdTo ? localMidnight(filter.createdTo) : null;
  return !!from && !!to && from.getTime() > to.getTime();
}

/** Whether a contact's created_at falls inside the range. */
export function isInCreatedRange(
  createdAt: string | null | undefined,
  range: CreatedRange | null
): boolean {
  if (!range) return true;
  if (!createdAt) return false;
  const t = new Date(createdAt).getTime();
  if (Number.isNaN(t)) return false;
  if (range.gte && t < new Date(range.gte).getTime()) return false;
  if (range.lt && t >= new Date(range.lt).getTime()) return false;
  return true;
}
