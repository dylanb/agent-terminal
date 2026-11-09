import { expect, it, vi } from 'vitest';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync, type ReadStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { addAbortSignal, Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSessionTurns } from '../../src/main/mcpSessionTurns';
import { hookInput, transcriptText, transcriptUserEntry } from '../helpers/fakeClaude';

vi.mock('node:fs/promises', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return { ...original, open: vi.fn(original.open) };
});

it('a boundary observation includes a prompt appended after an earlier in-flight transcript snapshot', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mcp-discovery-'));
  const session = { sessionId: 'session-1', transcriptPath: join(root, 'transcript.jsonl'), cwd: root };
  const turns = createSessionTurns({ launchOf: async () => ({ print: false, launchPrompt: false }) });
  writeFileSync(session.transcriptPath, '{"type":"assistant"}\n');
  turns.hook(1001, hookInput.sessionStart(session, 'startup'));
  turns.hook(1001, hookInput.userPromptSubmit(session, 'prompt-1', 'human request'));
  await turns.origin(1001);
  let snapshotRead!: () => void;
  let finishRead!: () => void;
  const snapshot = new Promise<void>(resolve => { snapshotRead = resolve; });
  const held = new Promise<void>(resolve => { finishRead = resolve; });
  const { open: realOpen } = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  vi.mocked(open).mockImplementationOnce(async (...args) => {
    const handle = await realOpen(...args);
    const createStream = handle.createReadStream.bind(handle);
    vi.spyOn(handle, 'createReadStream').mockImplementationOnce(options => {
      const source = createStream(options);
      return Readable.from((async function* () {
        for await (const chunk of source) yield chunk;
        snapshotRead();
        await held;
      })()) as ReadStream;
    });
    return handle;
  });
  try {
    const earlier = turns.discoverHumanPrompts();
    await snapshot;
    appendFileSync(session.transcriptPath, transcriptText([transcriptUserEntry({ ...session, promptId: 'prompt-1', uuid: 'entry-1', text: 'human request', timestamp: '2026-11-09T12:00:00Z', source: { kind: 'typed' } })]));
    const boundary = turns.discoverHumanPrompts();
    finishRead();
    await earlier;
    expect(await boundary).toMatchObject([{ type: 'mcp.prompt', text: 'human request' }]);
  } finally {
    finishRead();
    vi.mocked(open).mockReset();
    rmSync(root, { recursive: true, force: true });
  }
});


it('cancels in-flight transcript discovery without recording its incomplete evidence', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mcp-cancel-'));
  const session = { sessionId: 'session-1', transcriptPath: join(root, 'transcript.jsonl'), cwd: root };
  const turns = createSessionTurns({ launchOf: async () => ({ print: false, launchPrompt: false }) });
  writeFileSync(session.transcriptPath, transcriptText([transcriptUserEntry({ ...session, promptId: 'prompt-1', uuid: 'entry-1', text: 'human request', timestamp: '2026-11-09T12:00:00Z', source: { kind: 'typed' } })]));
  turns.hook(1001, hookInput.sessionStart(session, 'startup'));
  turns.hook(1001, hookInput.userPromptSubmit(session, 'prompt-1', 'human request'));
  await turns.origin(1001);
  let snapshotRead!: () => void;
  let finishRead!: () => void;
  const snapshot = new Promise<void>(resolve => { snapshotRead = resolve; });
  const held = new Promise<void>(resolve => { finishRead = resolve; });
  const { open: realOpen } = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  vi.mocked(open).mockImplementationOnce(async (...args) => {
    const handle = await realOpen(...args);
    const createStream = handle.createReadStream.bind(handle);
    vi.spyOn(handle, 'createReadStream').mockImplementationOnce(options => {
      const source = createStream(options);
      const paused = Readable.from((async function* () {
        for await (const chunk of source) yield chunk;
        snapshotRead();
        await held;
      })());
      return (options?.signal ? addAbortSignal(options.signal, paused) : paused) as ReadStream;
    });
    return handle;
  });
  try {
    const discovery = turns.discoverHumanPrompts();
    await snapshot;
    turns.cancelAuditDiscovery();
    finishRead();
    expect(await discovery).toEqual([]);
  } finally {
    finishRead();
    vi.mocked(open).mockReset();
    rmSync(root, { recursive: true, force: true });
  }
});


it('reports unexpected discovery failures once until recovery, while absence and cancellation stay quiet', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mcp-errors-'));
  const session = { sessionId: 'session-1', transcriptPath: join(root, 'transcript.jsonl'), cwd: root };
  const turns = createSessionTurns({ launchOf: async () => ({ print: false, launchPrompt: false }) });
  writeFileSync(session.transcriptPath, '{"type":"assistant"}\n');
  turns.hook(1001, hookInput.sessionStart(session, 'startup'));
  turns.hook(1001, hookInput.userPromptSubmit(session, 'prompt-1', 'human request'));
  await turns.origin(1001);
  const messages: string[] = [];
  const log = vi.spyOn(console, 'error').mockImplementation((...args) => { messages.push(args.join(' ')); });
  const { open: realOpen } = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  try {
    vi.mocked(open).mockRejectedValue(Object.assign(new Error('normal absence'), { code: 'ENOENT' }));
    expect(await turns.discoverHumanPrompts()).toEqual([]);
    expect(messages).toEqual([]);
    vi.mocked(open).mockRejectedValue(new Error('storage unavailable'));
    expect(await turns.discoverHumanPrompts()).toEqual([]);
    expect(await turns.discoverHumanPrompts()).toEqual([]);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('storage unavailable');
    vi.mocked(open).mockImplementation(realOpen);
    expect(await turns.discoverHumanPrompts()).toEqual([]);
    vi.mocked(open).mockRejectedValue('storage unavailable');
    expect(await turns.discoverHumanPrompts()).toEqual([]);
    expect(messages).toHaveLength(2);
    expect(messages[1]).toContain('storage unavailable');
    turns.cancelAuditDiscovery();
    expect(await turns.discoverHumanPrompts()).toEqual([]);
    expect(messages).toHaveLength(2);
  } finally {
    log.mockRestore();
    vi.mocked(open).mockReset();
    rmSync(root, { recursive: true, force: true });
  }
});
