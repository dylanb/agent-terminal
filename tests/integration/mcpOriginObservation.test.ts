import { expect, it } from 'vitest';
import { createSessionTurns, type SessionLaunch } from '../../src/main/mcpSessionTurns';
import { hookInput } from '../helpers/fakeClaude';

const session = { sessionId: 'caller', transcriptPath: '/owned/transcript', cwd: '/repo' };
it('delivers origin and its matching prompt as one observation', async () => {
  const turns = createSessionTurns({ launchOf: async () => ({ print: false, launchPrompt: false }), observeTranscript: async () => ({ origin: 'human', version: '1' }) });
  turns.hook(1, hookInput.sessionStart(session, 'startup'));
  turns.hook(1, hookInput.userPromptSubmit(session, 'first', 'original prompt'));
  const observed = await turns.observe(1, observation => observation);
  expect(observed).toMatchObject({ origin: 'human', prompt: { text: 'original prompt' } });
});

it.each(['stop', 'replacement', 'injected join'] as const)('does not authorize or misattribute a call after %s during observation', async change => {
  let release!: (value: SessionLaunch) => void;
  const turns = createSessionTurns({ launchOf: () => new Promise(resolve => { release = resolve; }), observeTranscript: async () => ({ origin: 'human', version: '1' }) });
  turns.hook(1, hookInput.sessionStart(session, 'startup'));
  turns.hook(1, hookInput.userPromptSubmit(session, 'first', 'original prompt'));
  const observing = turns.observe(1, observation => observation);
  switch (change) {
    case 'stop': turns.hook(1, hookInput.stop(session)); break;
    case 'replacement': turns.hook(1, hookInput.userPromptSubmit(session, 'second', 'replacement prompt')); break;
    case 'injected join':
      turns.injected('engine prompt', { submitted: true });
      turns.hook(1, hookInput.userPromptSubmit(session, 'first', 'engine prompt')); break;
    default: change satisfies never;
  }
  release({ print: false, launchPrompt: false });
  expect(await observing).toMatchObject({ origin: change === 'injected join' ? 'not-human' : 'undetermined', prompt: null });
});

it('propagates an operation failure without retrying the action as a transcript failure', async () => {
  const turns = createSessionTurns({ launchOf: async () => ({ print: false, launchPrompt: false }), observeTranscript: async () => ({ origin: 'human', version: '1' }) });
  turns.hook(1, hookInput.sessionStart(session, 'startup'));
  turns.hook(1, hookInput.userPromptSubmit(session, 'first', 'original prompt'));
  const effects: string[] = [];
  await expect(turns.observe(1, () => { effects.push('accepted'); throw new Error('operation failed'); })).rejects.toThrow('operation failed');
  expect(effects).toEqual(['accepted']);
});
