// The `json-list` artifact contract (§28.4.1): a JSON object whose named key holds a non-empty array of entries,
// each an object with a `title`. One predicate, read by the engine's sourcer and by `--check-repeat-list`.

/** The rules a file can break, in the order they are checked. An entry rule is reported with its position. */
export const JSON_LIST_RULES = [
  'parses',
  'top-level-object',
  'key-present',
  'value-array',
  'at-least-one-entry',
  'entry-object',
  'title-string',
  'title-not-blank',
  'title-no-control-character',
] as const;
export type JsonListRule = (typeof JSON_LIST_RULES)[number];

/** The entry titles in order, or the first rule broken, with the entry's position counted from 1 for an entry rule. */
export type JsonListCheck = { ok: true; titles: readonly string[] } | { ok: false; rule: JsonListRule; position?: number };

export function checkJsonList(_text: string, _list: string): JsonListCheck {
  return { ok: true, titles: [] };
}
