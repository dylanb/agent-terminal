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

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const CONTROL_CHARACTER = /\p{Cc}/u;

function entryProblem(entry: unknown): JsonListRule | null {
  if (!isObject(entry)) return 'entry-object';
  const title = entry.title;
  if (typeof title !== 'string') return 'title-string';
  if (title.trim().length === 0) return 'title-not-blank';
  if (CONTROL_CHARACTER.test(title)) return 'title-no-control-character';
  return null;
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
    const rule = entryProblem(entry);
    if (rule !== null) return { ok: false, rule, position: i + 1 };
    titles.push((entry as { title: string }).title);
  }
  return { ok: true, titles };
}

/** A well-formed `json-list` file holding `n` entries under `key`. */
export function exampleJsonList(key: string, n: number): string {
  const entries = Array.from({ length: n }, (_, i) => ({ title: `Entry ${i + 1}` }));
  return `${JSON.stringify({ [key]: entries }, null, 2)}\n`;
}
