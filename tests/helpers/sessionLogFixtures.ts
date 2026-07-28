/** One line of Claude Code's session JSONL, in the shape `extractTurn` decodes: a `timestamp`, the
 *  `message.id`/`requestId` pair the turn is billed under, and `message.model` + `message.usage`. Omitting
 *  a field omits it from the document, so a caller can build the half-identified and instant-less shapes
 *  the format really produces. */
export const turnLine = (opts: {
  ts?: string;
  id?: string;
  msgId?: string;
  reqId?: string;
  model?: string;
  input?: number;
  output?: number;
}): string =>
  JSON.stringify({
    type: 'assistant',
    ...(opts.ts === undefined ? {} : { timestamp: opts.ts }),
    ...(opts.reqId !== undefined ? { requestId: opts.reqId } : opts.id === undefined ? {} : { requestId: `req-${opts.id}` }),
    message: {
      ...(opts.msgId !== undefined ? { id: opts.msgId } : opts.id === undefined ? {} : { id: `msg-${opts.id}` }),
      model: opts.model ?? 'claude-sonnet-5',
      usage: { input_tokens: opts.input ?? 0, output_tokens: opts.output ?? 0 },
    },
  });

/** A session log's bytes: every line newline-terminated, as Claude Code writes them. */
export const logBytes = (...lines: string[]): string => `${lines.join('\n')}\n`;
