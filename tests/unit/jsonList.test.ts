import { describe, expect, it } from 'vitest';
import { checkJsonList, exampleJsonList } from '../../src/shared/jsonList';
import { JSON_LIST_CASES, type JsonListVerdict } from '../helpers/jsonListCases';

// #278 — the `json-list` predicate against the independent table of verdicts the ticket's rules give.

const verdictOf = (text: string, list: string): JsonListVerdict => {
  const r = checkJsonList(text, list);
  if (r.ok) return { wellFormed: true, titles: r.titles };
  return r.position === undefined ? { wellFormed: false, rule: r.rule } : { wellFormed: false, rule: r.rule, position: r.position };
};

describe('checkJsonList — a well-formed json-list file gives its titles, a bad one the first rule it breaks', () => {
  it.each(JSON_LIST_CASES.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    expect(verdictOf(c.text, c.list)).toEqual(c.expected);
  });
});

describe('checkJsonList over the canonical example as a base input', () => {
  const withEntry = (key: string, n: number, at: number, entry: unknown): string => {
    const doc = JSON.parse(exampleJsonList(key, n)) as Record<string, unknown[]>;
    doc[key][at - 1] = entry;
    return JSON.stringify(doc);
  };

  it('reports a blank title at the position it was planted', () => {
    expect(checkJsonList(withEntry('steps', 3, 2, { title: '  ' }), 'steps')).toEqual({ ok: false, rule: 'title-not-blank', position: 2 });
  });

  it('reports a non-object entry at the last position', () => {
    expect(checkJsonList(withEntry('tasks', 4, 4, 'x'), 'tasks')).toEqual({ ok: false, rule: 'entry-object', position: 4 });
  });

  it('reports key-present for a key the example does not hold', () => {
    expect(checkJsonList(exampleJsonList('tasks', 2), 'steps')).toEqual({ ok: false, rule: 'key-present' });
  });
});
