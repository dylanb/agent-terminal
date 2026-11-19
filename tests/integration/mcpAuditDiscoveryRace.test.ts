import { expect, it, vi } from 'vitest';
import { createSessionTurns } from '../../src/main/mcpSessionTurns';
import type { TranscriptObservation, ObserveTranscript } from '../../src/main/mcpTranscript';
import { hookInput } from '../helpers/fakeClaude';

function fixture(observeTranscript: ObserveTranscript) {
  const session = { sessionId: 'session-1', transcriptPath: '/owned/transcript.jsonl', cwd: '/repo' };
  const turns = createSessionTurns({ launchOf: async () => ({ print: false, launchPrompt: false }), observeTranscript });
  turns.hook(1001, hookInput.sessionStart(session, 'startup'));
  turns.hook(1001, hookInput.userPromptSubmit(session, 'prompt-1', 'human request'));
  return turns;
}

it('uses transcript evidence to attribute a human prompt without depending on its storage mechanism', async () => {
  const turns = fixture(async () => ({ origin: 'human', version: 'first' }));
  expect(await turns.observe(1001, observation => observation.origin)).toBe('human');
  expect(await turns.discoverHumanPrompts()).toMatchObject([{ text: 'human request' }]);
});

it('a boundary observation includes evidence arriving after an in-flight snapshot', async () => {
  let begin!: () => void;
  let finish!: (value: TranscriptObservation) => void;
  const started = new Promise<void>(resolve => { begin = resolve; });
  let observe: ObserveTranscript = async () => ({ origin: 'undetermined', version: 'empty' });
  const turns = fixture(request => observe(request));
  await turns.observe(1001, observation => observation.origin);
  observe = () => { begin(); return new Promise(resolve => { finish = resolve; }); };
  const earlier = turns.discoverHumanPrompts();
  await started;
  observe = async () => ({ origin: 'human', version: 'appended' });
  const boundary = turns.discoverHumanPrompts();
  finish({ origin: 'undetermined', version: 'empty' });
  await earlier;
  expect(await boundary).toMatchObject([{ text: 'human request' }]);
});

it('cancels in-flight discovery without recording incomplete evidence', async () => {
  let observe: ObserveTranscript = async () => ({ origin: 'undetermined', version: 'empty' });
  const turns = fixture(request => observe(request));
  await turns.observe(1001, observation => observation.origin);
  let begin!: () => void;
  const started = new Promise<void>(resolve => { begin = resolve; });
  observe = ({ signal }) => new Promise((_resolve, reject) => {
    signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    begin();
  });
  const discovery = turns.discoverHumanPrompts();
  await started;
  turns.cancelAuditDiscovery();
  expect(await discovery).toEqual([]);
});

it('reports unexpected discovery failures once until recovery, while absence and cancellation stay quiet', async () => {
  let observe: ObserveTranscript = async () => ({ origin: 'undetermined', version: 'empty' });
  const turns = fixture(request => observe(request));
  await turns.observe(1001, observation => observation.origin);
  const messages: string[] = [];
  const log = vi.spyOn(console, 'error').mockImplementation((...args) => { messages.push(args.join(' ')); });
  try {
    observe = async () => { throw Object.assign(new Error('normal absence'), { code: 'ENOENT' }); };
    expect(await turns.discoverHumanPrompts()).toEqual([]);
    expect(messages).toEqual([]);
    observe = async () => { throw new Error('storage unavailable'); };
    expect(await turns.discoverHumanPrompts()).toEqual([]);
    expect(await turns.discoverHumanPrompts()).toEqual([]);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('storage unavailable');
    observe = async () => ({ origin: 'undetermined', version: 'recovered' });
    expect(await turns.discoverHumanPrompts()).toEqual([]);
    observe = async () => { throw new Error('storage unavailable'); };
    expect(await turns.discoverHumanPrompts()).toEqual([]);
    expect(messages).toHaveLength(2);
    turns.cancelAuditDiscovery();
    expect(await turns.discoverHumanPrompts()).toEqual([]);
    expect(messages).toHaveLength(2);
  } finally { log.mockRestore(); }
});
