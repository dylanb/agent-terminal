// #207 — "states the shared text": the same words in the same order, ignoring line breaks, indentation and
// Markdown emphasis. Every drift and composer assertion of a shared definition goes through this one comparison.

const EMPHASIS_STARS = /\*+/g;
const EMPHASIS_UNDERSCORES = /(?<![\p{L}\p{N}])_+|_+(?![\p{L}\p{N}])/gu;
const QUALIFIER_SEPARATOR = /^[\s,:—–-]*/;
const CONTEXT_CHARS = 40;
const SENTENCE_END = /(?<=[.!?])\s+/;

export function normaliseText(text: string): string {
  return text.replace(EMPHASIS_STARS, '').replace(EMPHASIS_UNDERSCORES, '').replace(/\s+/g, ' ').trim();
}

function nonEmpty(text: string, what: string): string {
  const normalised = normaliseText(text);
  if (normalised.length === 0) throw new Error(`the ${what} is empty once normalised, so every document would match it`);
  return normalised;
}

export function statesText(doc: string, shared: string | readonly string[]): boolean {
  return normaliseText(doc).includes(nonEmpty(typeof shared === 'string' ? shared : shared.join('\n'), 'shared text'));
}

/** Whether one sentence of `doc` contains every needle, case-sensitively, once both are normalised. */
export function sentenceStates(doc: string, needles: readonly string[]): boolean {
  if (needles.length === 0) throw new Error('no needles, so every sentence would match');
  const wanted = needles.map((n) => nonEmpty(n, 'needle'));
  return normaliseText(doc)
    .split(SENTENCE_END)
    .some((sentence) => wanted.every((n) => sentence.includes(n)));
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
