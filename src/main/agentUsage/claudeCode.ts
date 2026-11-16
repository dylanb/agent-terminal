// §27.4

import { isTokenFigure, TOKEN_KINDS, type TokenKind } from '../../shared/tokenCounts';
import { isRecord } from '../yamlRecord';
import type { BilledCall } from './billedCall';

const USAGE_FIELD: Record<TokenKind, string> = {
  cacheRead: 'cache_read_input_tokens',
  cacheWrite: 'cache_creation_input_tokens',
  input: 'input_tokens',
  output: 'output_tokens',
};

/** One line's record of a call. Claude Code writes a streamed call on several lines and copies earlier calls into a
 *  resumed or forked session's file; every copy names the call by its message id and request id. */
export interface ClaudeCodeCopy {
  call: string;
  at: number;
  kinds: Partial<Record<TokenKind, number>>;
}

export function claudeCodeCopies(text: string): ClaudeCodeCopy[] {
  const copies: ClaudeCodeCopy[] = [];
  for (const line of text.split('\n')) {
    let doc: unknown;
    try {
      doc = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(doc) || !isRecord(doc.message) || !isRecord(doc.message.usage) || typeof doc.message.id !== 'string') continue;
    const at = typeof doc.timestamp === 'string' ? Date.parse(doc.timestamp) : Number.NaN;
    if (!Number.isFinite(at)) continue;
    const usage = doc.message.usage;
    const kinds: Partial<Record<TokenKind, number>> = {};
    for (const kind of TOKEN_KINDS) {
      const figure = usage[USAGE_FIELD[kind]];
      if (isTokenFigure(figure)) kinds[kind] = figure;
    }
    copies.push({ call: JSON.stringify([doc.message.id, typeof doc.requestId === 'string' ? doc.requestId : '']), at, kinds });
  }
  return copies;
}

/** Each call once, however many copies the logs hold. A later copy of a streamed call can carry a larger figure than
 *  the first, so each kind takes the largest among the copies; the call is placed at its earliest copy. */
export function claudeCodeCalls(copies: Iterable<ClaudeCodeCopy>): BilledCall[] {
  const calls = new Map<string, BilledCall>();
  for (const copy of copies) {
    const seen = calls.get(copy.call);
    if (seen === undefined) {
      calls.set(copy.call, { at: copy.at, kinds: { ...copy.kinds } });
      continue;
    }
    seen.at = Math.min(seen.at, copy.at);
    for (const kind of TOKEN_KINDS) {
      const figure = copy.kinds[kind];
      if (figure !== undefined) seen.kinds[kind] = Math.max(seen.kinds[kind] ?? 0, figure);
    }
  }
  return [...calls.values()];
}
