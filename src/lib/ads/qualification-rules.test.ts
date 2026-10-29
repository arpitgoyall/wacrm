import { describe, it, expect } from 'vitest';
import { evaluateQualification } from './outcomes';
describe('business qualification rules', () => {
  it('does not qualify missing answers, even when an empty value is configured', () =>
    expect(
      evaluateQualification(
        [{ source: 'answer', field: 'budget', operator: 'equals', value: '' }],
        { contact: {}, answer: {}, stage: [] },
        'all'
      )
    ).toBe(false));
  it('supports numeric answers and CRM stage membership', () =>
    expect(
      evaluateQualification(
        [
          { source: 'answer', field: 'budget', operator: 'gte', value: '1000' },
          {
            source: 'stage',
            field: '',
            operator: 'contains',
            value: 'qualified',
          },
        ],
        { contact: {}, answer: { budget: 1500 }, stage: ['new', 'qualified'] },
        'all'
      )
    ).toBe(true));
  it('uses all/any explicitly and does not treat an empty stage list as present', () => {
    const rules = [
      {
        source: 'contact' as const,
        field: 'city',
        operator: 'equals' as const,
        value: 'Mumbai',
      },
      {
        source: 'stage' as const,
        field: '',
        operator: 'exists' as const,
        value: '',
      },
    ];
    const facts = { contact: { city: 'Mumbai' }, answer: {}, stage: [] };
    expect(evaluateQualification(rules, facts, 'all')).toBe(false);
    expect(evaluateQualification(rules, facts, 'any')).toBe(true);
  });
});
