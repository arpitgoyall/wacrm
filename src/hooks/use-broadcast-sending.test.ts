import { describe, expect, it } from 'vitest';
import { resolveVariables } from './use-broadcast-sending';
import type { Contact } from '@/types';

const contact: Contact = {
  id: 'contact-1',
  user_id: 'user-1',
  account_id: 'account-1',
  name: 'Ada',
  phone: '+15551230000',
  email: undefined,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

describe('resolveVariables fallbacks', () => {
  it('uses fallback for missing contact, custom, deal, and CSV values', () => {
    expect(resolveVariables({
      '1': { type: 'field', value: 'email', fallback: 'friend' },
      '2': { type: 'custom_field', value: 'missing', fallback: 'customer' },
      '3': { type: 'deal', value: 'notes', fallback: 'your deal' },
      '4': { type: 'csv_column', value: 'city', fallback: 'your city' },
    }, contact, new Map(), {}, {})).toEqual(['friend', 'customer', 'your deal', 'your city']);
  });

  it('keeps real values, including a numeric deal value of zero', () => {
    expect(resolveVariables({
      '1': { type: 'field', value: 'name', fallback: 'friend' },
      '2': { type: 'deal', value: 'value', fallback: 'unknown' },
      '3': { type: 'csv_column', value: 'city', fallback: 'elsewhere' },
    }, contact, undefined, { value: 0 }, { city: 'Pune' })).toEqual(['Ada', '0', 'Pune']);
  });
});
