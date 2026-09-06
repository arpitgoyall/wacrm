import { describe, expect, it } from 'vitest';

import {
  NODE_CATEGORIES,
  NODE_META,
  flowVarSuggestions,
  groupNodeTypesByCategory,
  type BuilderNode,
  type NodeType,
} from './shared';
import { CTWA_VAR_KEYS } from '../../lib/flows/types';

const ALL_TYPES = Object.keys(NODE_META) as NodeType[];

describe('node categories', () => {
  it('assigns every node type to a known category', () => {
    const known = new Set(NODE_CATEGORIES.map((c) => c.id));
    for (const type of ALL_TYPES) {
      expect(known.has(NODE_META[type].category)).toBe(true);
    }
  });
});

describe('groupNodeTypesByCategory', () => {
  it('keeps the categories in NODE_CATEGORIES order and drops empty ones', () => {
    // Only messaging + flow types — the logic group must not appear.
    const groups = groupNodeTypesByCategory(['send_message', 'start', 'end']);
    expect(groups.map((g) => g.id)).toEqual(['messaging', 'flow']);
  });

  it('preserves the input order within a category', () => {
    const groups = groupNodeTypesByCategory([
      'send_media',
      'send_message',
      'send_buttons',
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].types).toEqual([
      'send_media',
      'send_message',
      'send_buttons',
    ]);
  });

  it('partitions the full type list without losing or duplicating a type', () => {
    const grouped = groupNodeTypesByCategory(ALL_TYPES).flatMap((g) => g.types);
    expect([...grouped].sort()).toEqual([...ALL_TYPES].sort());
  });
});

describe('flowVarSuggestions', () => {
  const node = (
    node_type: NodeType,
    config: Record<string, unknown> = {},
  ): BuilderNode => ({ node_key: node_type, node_type, config });

  it('offers the ctwa_* keys even for a flow with no capture nodes', () => {
    expect(flowVarSuggestions([node('start'), node('send_message')])).toEqual([
      ...CTWA_VAR_KEYS,
    ]);
  });

  it('appends var_key from collect_input / send_buttons / send_list, in node order', () => {
    const out = flowVarSuggestions([
      node('collect_input', { var_key: 'city' }),
      node('send_buttons', { var_key: 'plan' }),
      node('send_list', { var_key: 'slot' }),
      node('send_message', { var_key: 'ignored' }), // not a capture node
    ]);
    expect(out).toEqual([...CTWA_VAR_KEYS, 'city', 'plan', 'slot']);
  });

  it('dedupes and drops blank / non-string var_key', () => {
    const out = flowVarSuggestions([
      node('collect_input', { var_key: '  ' }),
      node('send_buttons', { var_key: 'ctwa_source_id' }), // already a ctwa key
      node('send_list', { var_key: 'city' }),
      node('collect_input', { var_key: 'city' }), // repeat
    ]);
    expect(out).toEqual([...CTWA_VAR_KEYS, 'city']);
  });
});
