import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { afterEach, expect, it } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSessionTurns, type SessionLaunch } from '../../src/main/mcpSessionTurns';
import { hookInput, transcriptText, transcriptUserEntry } from '../helpers/fakeClaude';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it.each(['process loss', 'later injection'])('records historical human prompt evidence after %s while the live guard stays closed', async interruption => {
  const root = mkdtempSync(join(tmpdir(), 'mcp-prompt-')); roots.push(root);
  const session = { sessionId: 'session-1', transcriptPath: join(root, 'transcript.jsonl'), cwd: root };
  let launch: SessionLaunch | null = { print: false, launchPrompt: false };
  const turns = createSessionTurns({ launchOf: async () => launch });
  turns.hook(1001, hookInput.sessionStart(session, 'startup'));
  turns.hook(1001, hookInput.userPromptSubmit(session, 'prompt-1', 'human request'));
  expect(await turns.origin(1001)).toBe('undetermined');
  appendFileSync(session.transcriptPath, transcriptText([transcriptUserEntry({ ...session, promptId: 'prompt-1', uuid: 'entry-1', text: 'human request', timestamp: '2026-11-09T12:00:00Z', source: { kind: 'typed' } })]));
  if (interruption === 'process loss') launch = null;
  else turns.injected('later engine request', { submitted: true });
  expect(await turns.origin(1001)).toBe('undetermined');
  expect(await turns.discoverHumanPrompts()).toMatchObject([{ type: 'mcp.prompt', text: 'human request' }]);
});


it('discovers an original human prompt asynchronously and retains it across later transcript growth', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mcp-prompt-')); roots.push(root);
  const session = { sessionId: 'session-1', transcriptPath: join(root, 'transcript.jsonl'), cwd: root };
  const turns = createSessionTurns({ launchOf: async () => ({ print: false, launchPrompt: false }) });
  turns.hook(1001, hookInput.sessionStart(session, 'startup'));
  turns.hook(1001, hookInput.userPromptSubmit(session, 'prompt-1', 'human request'));
  await turns.origin(1001);
  appendFileSync(session.transcriptPath, transcriptText([transcriptUserEntry({ ...session, promptId: 'prompt-1', uuid: 'entry-1', text: 'human request', timestamp: '2026-11-09T12:00:00Z', source: { kind: 'typed' } })]));
  const pending = turns.discoverHumanPrompts();
  const concurrent = turns.discoverHumanPrompts();
  expect(await pending).toMatchObject([{ type: 'mcp.prompt', text: 'human request' }]);
  expect(await concurrent).toEqual(await pending);
  appendFileSync(session.transcriptPath, transcriptText([transcriptUserEntry({ ...session, promptId: 'prompt-2', uuid: 'entry-2', text: 'later request', timestamp: '2026-11-09T12:01:00Z', source: { kind: 'typed' } })]));
  expect(await turns.discoverHumanPrompts()).toEqual(await pending);
  expect(await turns.discoverHumanPrompts()).toEqual(await pending);
});

it('retains a definitive generated origin during later audit observation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mcp-prompt-')); roots.push(root);
  const session = { sessionId: 'session-1', transcriptPath: join(root, 'transcript.jsonl'), cwd: root };
  const turns = createSessionTurns({ launchOf: async () => ({ print: false, launchPrompt: false }) });
  turns.hook(1001, hookInput.sessionStart(session, 'startup'));
  turns.hook(1001, hookInput.userPromptSubmit(session, 'prompt-1', 'scheduled request'));
  await turns.origin(1001);
  appendFileSync(session.transcriptPath, transcriptText([transcriptUserEntry({ ...session, promptId: 'prompt-1', uuid: 'entry-1', text: 'scheduled request', timestamp: '2026-11-09T12:00:00Z', source: { kind: 'scheduled' } })]));
  expect(await turns.discoverHumanPrompts()).toEqual([]);
  expect(await turns.discoverHumanPrompts()).toEqual([]);
});


it('keeps asynchronous discovery best-effort when the transcript cannot be read', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mcp-prompt-')); roots.push(root);
  const session = { sessionId: 'session-1', transcriptPath: join(root, 'transcript.jsonl'), cwd: root };
  const turns = createSessionTurns({ launchOf: async () => ({ print: false, launchPrompt: false }) });
  turns.hook(1001, hookInput.sessionStart(session, 'startup'));
  turns.hook(1001, hookInput.userPromptSubmit(session, 'prompt-1', 'human request'));
  await turns.origin(1001);
  mkdirSync(session.transcriptPath);
  expect(await turns.discoverHumanPrompts()).toEqual([]);
  rmSync(session.transcriptPath, { recursive: true });
  appendFileSync(session.transcriptPath, transcriptText([transcriptUserEntry({ ...session, promptId: 'prompt-1', uuid: 'entry-1', text: 'human request', timestamp: '2026-11-09T12:00:00Z', source: { kind: 'typed' } })]));
  expect(await turns.discoverHumanPrompts()).toMatchObject([{ type: 'mcp.prompt', text: 'human request' }]);
});


it('rejects a non-regular transcript without consuming its prompt bytes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mcp-prompt-')); roots.push(root);
  const session = { sessionId: 'session-1', transcriptPath: join(root, 'transcript.jsonl'), cwd: root };
  const turns = createSessionTurns({ launchOf: async () => ({ print: false, launchPrompt: false }) });
  turns.hook(1001, hookInput.sessionStart(session, 'startup'));
  turns.hook(1001, hookInput.userPromptSubmit(session, 'prompt-1', 'human request'));
  await turns.origin(1001);
  execFileSync('mkfifo', [session.transcriptPath]);
  const bytes = transcriptText([transcriptUserEntry({ ...session, promptId: 'prompt-1', uuid: 'entry-1', text: 'human request', timestamp: '2026-11-09T12:00:00Z', source: { kind: 'typed' } })]);
  const writer = spawn(process.execPath, ['-e', 'require("node:fs").writeFileSync(process.argv[1], process.argv[2])', session.transcriptPath, bytes], { stdio: 'ignore' });
  const exited = once(writer, 'exit');
  try { expect(await turns.discoverHumanPrompts()).toEqual([]); }
  finally { writer.kill(); await exited; }
});


it('discovers an earlier human prompt for the first time after a newer transcript prompt while the live guard refuses it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mcp-history-')); roots.push(root);
  const session = { sessionId: 'session-1', transcriptPath: join(root, 'transcript.jsonl'), cwd: root };
  const turns = createSessionTurns({ launchOf: async () => ({ print: false, launchPrompt: false }) });
  turns.hook(1001, hookInput.sessionStart(session, 'startup'));
  turns.hook(1001, hookInput.userPromptSubmit(session, 'prompt-1', 'original human request'));
  await turns.origin(1001);
  appendFileSync(session.transcriptPath, transcriptText([
    transcriptUserEntry({ ...session, promptId: 'prompt-1', uuid: 'entry-1', text: 'original human request', timestamp: '2026-11-09T12:00:00Z', source: { kind: 'typed' } }),
    transcriptUserEntry({ ...session, promptId: 'prompt-2', uuid: 'entry-2', text: 'newer request', timestamp: '2026-11-09T12:01:00Z', source: { kind: 'typed' } }),
  ]));
  expect(await turns.origin(1001)).toBe('undetermined');
  expect(await turns.discoverHumanPrompts()).toMatchObject([{ type: 'mcp.prompt', text: 'original human request' }]);
});
