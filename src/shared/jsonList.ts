export const JSON_LIST_DOCUMENT_RULES = ['parses', 'top-level-object', 'key-present', 'value-array', 'at-least-one-entry'] as const;
export type JsonListDocumentRule = (typeof JSON_LIST_DOCUMENT_RULES)[number];

export const JSON_LIST_ENTRY_RULES = ['entry-object', 'title-string', 'title-not-blank', 'title-no-control-character'] as const;
export type JsonListEntryRule = (typeof JSON_LIST_ENTRY_RULES)[number];

export const JSON_LIST_SHAPE = {
  entryTitleKey: 'title',
} as const;

export type JsonListCheck =
  | { ok: true; titles: readonly string[] }
  | { ok: false; rule: JsonListDocumentRule }
  | { ok: false; rule: JsonListEntryRule; position: number };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const CONTROL_CHARACTER = /\p{Cc}/u;

function entryTitle(entry: unknown): { title: string } | { rule: JsonListEntryRule } {
  if (!isObject(entry)) return { rule: 'entry-object' };
  const title = entry[JSON_LIST_SHAPE.entryTitleKey];
  if (typeof title !== 'string') return { rule: 'title-string' };
  if (title.trim().length === 0) return { rule: 'title-not-blank' };
  if (CONTROL_CHARACTER.test(title)) return { rule: 'title-no-control-character' };
  return { title };
}

export function checkJsonList(text: string, list: string): JsonListCheck {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return { ok: false, rule: 'parses' };
  }
  if (!isObject(doc)) return { ok: false, rule: 'top-level-object' };
  if (!Object.prototype.hasOwnProperty.call(doc, list)) return { ok: false, rule: 'key-present' };
  const entries = doc[list];
  if (!Array.isArray(entries)) return { ok: false, rule: 'value-array' };
  if (entries.length === 0) return { ok: false, rule: 'at-least-one-entry' };
  const titles: string[] = [];
  for (const [i, entry] of entries.entries()) {
    const checked = entryTitle(entry);
    if ('rule' in checked) return { ok: false, rule: checked.rule, position: i + 1 };
    titles.push(checked.title);
  }
  return { ok: true, titles };
}

export function exampleJsonList(key: string, n: number): string {
  const entries = Array.from({ length: n }, (_, i) => ({ [JSON_LIST_SHAPE.entryTitleKey]: `Entry ${i + 1}` }));
  return `${JSON.stringify({ [key]: entries }, null, 2)}\n`;
}
