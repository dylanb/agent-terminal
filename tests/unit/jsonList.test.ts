import { describe, expect, it } from 'vitest';
import { checkJsonList } from '../../src/shared/jsonList';
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
