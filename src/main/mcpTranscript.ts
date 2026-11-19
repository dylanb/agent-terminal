import { open } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { setImmediate as yieldImmediate } from 'node:timers/promises';
import { constants, type Stats } from 'node:fs';
import { stripPasteBreakout } from '../shared/paste';
import type { TurnOrigin } from '../shared/turnOrigin';
import type { SessionPrompt } from './sessionPrompt';

export interface TranscriptObservation { origin: TurnOrigin; version: string; messages?: Omit<SessionPrompt, 'turnId'>[] }
export type ObserveTranscript = (request: {
  file: string;
  promptId: string;
  prompt: string;
  scope?: 'current' | 'historical';
  unchangedVersion?: string;
  signal?: AbortSignal;
}) => Promise<TranscriptObservation | null>;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function promptText(text: string): string {
  return stripPasteBreakout(text).replace(/\r\n?/g, '\n').trim();
}

export function matchesInjectedPrompt(injected: string, reported: string): boolean {
  const text = promptText(reported);
  if (injected === text) return true;
  const envelope = /^<pasted_content id="([^"\r\n]+)">\n([\s\S]*)\n<\/pasted_content(?: id="\1")?>$/.exec(text);
  return envelope !== null && injected === promptText(envelope[2]);
}

function entryText(entry: Record<string, unknown>): string | null {
  const content = isRecord(entry.message) ? entry.message.content : undefined;
  if (typeof content === 'string') return promptText(content);
  if (!Array.isArray(content)) return null;
  const texts = content.flatMap((block) => (isRecord(block) && block.type === 'text' && typeof block.text === 'string' ? [block.text] : []));
  return texts.length === 0 ? null : promptText(texts.join('\n'));
}

const GENERATED_ORIGINS: ReadonlySet<string> = new Set(['scheduled', 'task-notification', 'peer']);

function transcriptReader(promptId: string, prompt: string) {
  let first: Record<string, unknown> | undefined;
  let latest: string | undefined;
  const messages = new Map<string, Omit<SessionPrompt, 'turnId'>>();
  return {
    line(text: string) {
      let entry: unknown;
      try { entry = JSON.parse(text); } catch { return; }
      if (!isRecord(entry) || entry.isSidechain === true) return;
      if (entry.type === 'attachment' && first && latest === promptId && entryText(first) === prompt) {
        const message = entry.attachment;
        if (isRecord(message) && message.type === 'queued_command' && message.commandMode === 'prompt'
          && isRecord(message.origin) && message.origin.kind === 'human' && message.humanTurn === true
          && typeof message.source_uuid === 'string' && message.source_uuid !== '' && typeof message.prompt === 'string'
          && typeof message.timestamp === 'string' && Number.isFinite(Date.parse(message.timestamp))) {
          messages.set(message.source_uuid, { id: message.source_uuid, text: message.prompt, occurredAt: message.timestamp });
        }
      }
      if (entry.type !== 'user' || typeof entry.promptId !== 'string') return;
      latest = entry.promptId;
      if (latest === promptId && !first) first = entry;
    },
    messages: () => [...messages.values()],
    origin(scope: 'current' | 'historical'): TurnOrigin {
      if ((scope === 'current' && latest !== promptId) || !first || entryText(first) !== prompt) return 'undetermined';
      const kind = isRecord(first.origin) ? first.origin.kind : undefined;
      if (kind === 'human') return 'human';
      if (typeof kind === 'string' && GENERATED_ORIGINS.has(kind)) return 'not-human';
      if (kind === undefined && first.promptSource === 'sdk') return 'not-human';
      return 'undetermined';
    },
  };
}

const transcriptVersion = (value: Stats): string => [value.dev, value.ino, value.size, value.mtimeMs, value.ctimeMs].join(':');

export const observeTranscript: ObserveTranscript = async ({ file, promptId, prompt, unchangedVersion, signal, scope = 'current' }) => {
  signal?.throwIfAborted();
  const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    signal?.throwIfAborted();
    const info = await handle.stat();
    signal?.throwIfAborted();
    if (!info.isFile()) return null;
    const version = transcriptVersion(info);
    if (version === unchangedVersion) return null;
    if (info.size === 0) return { origin: 'undetermined', version };
    const reader = transcriptReader(promptId, prompt);
    const input = handle.createReadStream({ encoding: 'utf8', highWaterMark: 64 * 1024, end: info.size - 1, autoClose: false, signal });
    const lines = createInterface({ input, crlfDelay: Infinity });
    let count = 0;
    try {
      for await (const line of lines) {
        reader.line(line);
        if (++count % 64 === 0) await yieldImmediate();
      }
      return { origin: reader.origin(scope), version, messages: reader.messages() };
    } finally { lines.close(); input.destroy(); }
  } finally { await handle.close(); }
};
