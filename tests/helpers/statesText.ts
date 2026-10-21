// #207 — "states the shared text": the same words in the same order, ignoring line breaks, indentation and
// Markdown emphasis.

const EMPHASIS_STARS = /\*+/g;
const EMPHASIS_UNDERSCORES = /(?<![\p{L}\p{N}])_+|_+(?![\p{L}\p{N}])/gu;
const QUALIFIER_SEPARATOR = /^[\s,:—–-]*/;
const CONTEXT_CHARS = 40;
const SENTENCE_END = /(?<=[.!?])\s+/;

export interface TextMatch {
  ignoreCase?: boolean;
}

function normaliseText(text: string): string {
  return text.replace(EMPHASIS_STARS, '').replace(EMPHASIS_UNDERSCORES, '').replace(/\s+/g, ' ').trim();
}

function folded(text: string, match: TextMatch): string {
  const normalised = normaliseText(text);
  return match.ignoreCase === true ? normalised.toLowerCase() : normalised;
}

function nonEmpty(text: string, what: string, match: TextMatch = {}): string {
  const normalised = folded(text, match);
  if (normalised.length === 0) throw new Error(`the ${what} is empty once normalised, so every document would match it`);
  return normalised;
}

const joined = (shared: string | readonly string[]): string => (typeof shared === 'string' ? shared : shared.join('\n'));

export function statesText(doc: string, shared: string | readonly string[], match: TextMatch = {}): boolean {
  return folded(doc, match).includes(nonEmpty(joined(shared), 'shared text', match));
}

/** How many times `doc` states `shared`, counting non-overlapping copies. */
export function timesStated(doc: string, shared: string | readonly string[], match: TextMatch = {}): number {
  return folded(doc, match).split(nonEmpty(joined(shared), 'shared text', match)).length - 1;
}

/** Whether two texts are the same words in the same order. */
export function sameText(a: string | readonly string[], b: string | readonly string[]): boolean {
  return nonEmpty(joined(a), 'text') === nonEmpty(joined(b), 'text');
}

/** `doc`'s sentences, once normalised. */
export function sentencesOf(doc: string): string[] {
  return normaliseText(doc).split(SENTENCE_END);
}

/** Whether one sentence of `doc` contains every needle, once both are normalised. */
export function sentenceStates(doc: string, needles: readonly string[], match: TextMatch = {}): boolean {
  if (needles.length === 0) throw new Error('no needles, so every sentence would match');
  const wanted = needles.map((n) => nonEmpty(n, 'needle', match));
  return sentencesOf(doc).some((sentence) => wanted.every((n) => folded(sentence, match).includes(n)));
}

/** Each case-insensitive occurrence of `phrase` in `doc` that the `qualifier` does not follow (a separating
 *  comma, colon or dash allowed between them), as a snippet of its surrounding text for the failure message. */
export function unqualifiedOccurrences(doc: string, phrase: string, qualifier: string): string[] {
  const text = normaliseText(doc);
  const lower = text.toLowerCase();
  const needle = nonEmpty(phrase, 'phrase').toLowerCase();
  const tail = nonEmpty(qualifier, 'qualifier').toLowerCase();
  const hits: string[] = [];
  for (let at = lower.indexOf(needle); at !== -1; at = lower.indexOf(needle, at + needle.length)) {
    const after = lower.slice(at + needle.length).replace(QUALIFIER_SEPARATOR, '');
    if (!after.startsWith(tail)) hits.push(text.slice(Math.max(0, at - CONTEXT_CHARS), at + needle.length + CONTEXT_CHARS));
  }
  return hits;
}
