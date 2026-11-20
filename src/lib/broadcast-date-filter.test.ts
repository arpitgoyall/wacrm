import { describe, it, expect } from 'vitest';
import {
  createdRange,
  isCreatedRangeInverted,
  isInCreatedRange,
} from './broadcast-date-filter';

const local = (y: number, m: number, d: number, h = 0, min = 0) =>
  new Date(y, m - 1, d, h, min).toISOString();

describe('createdRange', () => {
  it('returns null when no dates are picked', () => {
    expect(createdRange({})).toBeNull();
    expect(createdRange({ createdFrom: '', createdTo: '' })).toBeNull();
  });

  it('makes "to" inclusive of the whole day', () => {
    const r = createdRange({ createdTo: '2026-11-15' });
    expect(r).toEqual({ lt: local(2026, 11, 16) });
  });

  it('starts "from" at local midnight', () => {
    expect(createdRange({ createdFrom: '2026-11-01' })).toEqual({
      gte: local(2026, 11, 1),
    });
  });

  it('ignores malformed or impossible days', () => {
    expect(createdRange({ createdFrom: 'nope', createdTo: '2026-02-31' })).toBeNull();
  });
});

describe('isInCreatedRange', () => {
  const range = createdRange({ createdFrom: '2026-11-01', createdTo: '2026-11-15' });

  it('keeps contacts inside the range, both ends inclusive', () => {
    expect(isInCreatedRange(local(2026, 11, 1, 0, 0), range)).toBe(true);
    expect(isInCreatedRange(local(2026, 11, 15, 23, 59), range)).toBe(true);
  });

  it('drops contacts outside the range', () => {
    expect(isInCreatedRange(local(2026, 10, 31, 23, 59), range)).toBe(false);
    expect(isInCreatedRange(local(2026, 11, 16, 0, 0), range)).toBe(false);
  });

  it('passes everything when no range, drops missing dates when one is set', () => {
    expect(isInCreatedRange(undefined, null)).toBe(true);
    expect(isInCreatedRange(null, range)).toBe(false);
  });
});

describe('isCreatedRangeInverted', () => {
  it('flags from after to', () => {
    expect(isCreatedRangeInverted({ createdFrom: '2026-11-16', createdTo: '2026-11-01' })).toBe(true);
    expect(isCreatedRangeInverted({ createdFrom: '2026-11-01', createdTo: '2026-11-16' })).toBe(false);
    expect(isCreatedRangeInverted({ createdTo: '2026-11-01' })).toBe(false);
  });
});
