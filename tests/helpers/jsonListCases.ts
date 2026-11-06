// The expected verdict on `json-list` file texts, written from the ticket's definition of a well-formed file
// and the plan's rulings on it (R3 trim whitespace, R5 duplicate keys, R6 the first rule broken), never from
// the predicate it grades. One table serves the predicate's unit test, the engine's sourcing test, the
// `--check-repeat-list` test and the test that the two agree. Every case is valid UTF-8 with no byte-order
// mark, so a file holding the text is judged the same as the text: cases about bytes belong to the read.

/** The rules a file can break, in the order R6 checks them. An entry rule is reported with its position. */
export type JsonListRule =
  | 'parses'
  | 'top-level-object'
  | 'key-present'
  | 'value-array'
  | 'at-least-one-entry'
  | 'entry-object'
  | 'title-string'
  | 'title-not-blank'
  | 'title-no-control-character';

export type JsonListVerdict =
  | { wellFormed: true; titles: readonly string[] }
  | { wellFormed: false; rule: JsonListRule; position?: number };

export interface JsonListCase {
  name: string;
  /** The list key the check is given. */
  list: string;
  text: string;
  expected: JsonListVerdict;
}

const KEY = 'steps';

/** A file whose `list` holds one entry per title, beside a top-level `marker` key the rules ignore. */
export function jsonListText(titles: readonly string[], list = KEY): string {
  return JSON.stringify({ marker: 'ignored', [list]: titles.map((title) => ({ title })) }, null, 2);
}

/** `n` titles, each different from every other. */
export function distinctTitles(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `Entry ${i + 1} of the list`);
}

const wellFormed = (name: string, titles: readonly string[], text = jsonListText(titles), list = KEY): JsonListCase => ({
  name,
  list,
  text,
  expected: { wellFormed: true, titles },
});
const broken = (name: string, text: string, rule: JsonListRule, position?: number, list = KEY): JsonListCase => ({
  name,
  list,
  text,
  expected: position === undefined ? { wellFormed: false, rule } : { wellFormed: false, rule, position },
});
const entries = (...items: unknown[]): string => JSON.stringify({ [KEY]: items });

/** A well-formed file of `n` distinct entries: the count cases 1, several, the cap, and over it. */
export const sizedJsonList = (n: number): JsonListCase => wellFormed(`${n} entries`, distinctTitles(n));

export const JSON_LIST_CASES: readonly JsonListCase[] = [
  sizedJsonList(1),
  sizedJsonList(3),
  sizedJsonList(50),
  sizedJsonList(51),
  wellFormed('two entries with the same title', ['Same title', 'Same title']),
  wellFormed('extra keys in the file and in an entry', ['Kept title'], JSON.stringify({ version: 2, [KEY]: [{ title: 'Kept title', id: 7, done: false }] })),
  wellFormed('a title holding U+2028 and a bidi override', ['line\u2028sep \u202Eflipped']),
  wellFormed('a title of 150 characters', ['t'.repeat(150)]),
  wellFormed('the list key repeated, the last value winning', ['Last wins'], `{"${KEY}": "not a list", "${KEY}": [{"title": "Last wins"}]}`),
  wellFormed('an entry repeating title, the last value winning', ['Second title'], `{"${KEY}": [{"title": 1, "title": "Second title"}]}`),
  wellFormed('a __proto__ list key as an ordinary own property', ['Own proto'], '{"__proto__": [{"title": "Own proto"}]}', '__proto__'),
  broken('text that is not JSON', '{"steps": [', 'parses'),
  broken('an empty file', '', 'parses'),
  broken('a top-level array', '[{"title": "a"}]', 'top-level-object'),
  broken('a top-level null', 'null', 'top-level-object'),
  broken('a top-level string', '"steps"', 'top-level-object'),
  broken('the list key absent', '{"other": [{"title": "a"}]}', 'key-present'),
  broken('the list key only inherited', '{}', 'key-present', undefined, 'toString'),
  broken('the list value an object', '{"steps": {"title": "a"}}', 'value-array'),
  broken('the list value a string', '{"steps": "a, b"}', 'value-array'),
  broken('the list empty', '{"steps": []}', 'at-least-one-entry'),
  broken('the list key repeated, the last value empty', `{"${KEY}": [{"title": "a"}], "${KEY}": []}`, 'at-least-one-entry'),
  broken('a number as the first entry', entries(1), 'entry-object', 1),
  broken('null as the second entry', entries({ title: 'a' }, null), 'entry-object', 2),
  broken('an array as the third entry', entries({ title: 'a' }, { title: 'b' }, [{ title: 'c' }]), 'entry-object', 3),
  broken('an entry without a title', entries({ name: 'a' }), 'title-string', 1),
  broken('a number as a title', entries({ title: 'a' }, { title: 42 }), 'title-string', 2),
  broken('an empty title', entries({ title: '' }), 'title-not-blank', 1),
  broken('a title of spaces', entries({ title: 'a' }, { title: '   ' }), 'title-not-blank', 2),
  broken('a title of only U+00A0', entries({ title: '\u00A0' }), 'title-not-blank', 1),
  broken('a title of only U+FEFF', entries({ title: '\uFEFF' }), 'title-not-blank', 1),
  broken('a title of only a line break, blank before it is a control character', entries({ title: '\n' }), 'title-not-blank', 1),
  broken('a title holding a line break', entries({ title: 'first\nsecond' }), 'title-no-control-character', 1),
  broken('a title holding a tab', entries({ title: 'a' }, { title: 'col\tcol' }), 'title-no-control-character', 2),
  broken('a title holding DEL', entries({ title: 'del\u007F' }), 'title-no-control-character', 1),
  broken('a title holding NEL', entries({ title: 'nel\u0085' }), 'title-no-control-character', 1),
  broken('the earliest broken entry is named', entries({ title: 'a' }, { title: 'b\r' }, 'not an entry'), 'title-no-control-character', 2),
];
