import { afterEach, expect, it } from 'vitest';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import queued from '../fixtures/claude/queued-message-2.1.326.json';
import { createSessionTurns } from '../../src/main/mcpSessionTurns';
import { createMcpSessionAudit } from '../../src/main/mcpSessionAudit';
import { createAuditRecorder } from '../../src/main/auditRecorder';
import { auditFilePath } from '../../src/main/auditPaths';
import { parseAuditStream } from '../../src/shared/audit';
import { hookInput, transcriptText, transcriptUserEntry } from '../helpers/fakeClaude';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it.each([
  { injected: false, call: true },
  { injected: true, call: true },
  { injected: false, call: false },
])('audits a captured mid-turn human message: %j', async ({ injected, call: makeCall }) => {
  const root = mkdtempSync(join(tmpdir(), 'queued-audit-')); roots.push(root);
  const repo = join(root, 'repo');
  const now = new Date('2026-11-17T21:42:00Z');
  const session = { sessionId: 'session', transcriptPath: join(root, 'transcript.jsonl'), cwd: repo };
  const sessions = createSessionTurns({ launchOf: async () => ({ print: false, launchPrompt: false }) });
  const audit = createAuditRecorder({ root, now: () => now, flowName: () => 'work' });
  const recording = createMcpSessionAudit({ sessions, audit, repo: () => repo });
  const events = () => parseAuditStream(readFileSync(auditFilePath(root, repo, 'work', now), 'utf8')).events;
  try {
    audit.recordTransition(repo, 'start', { status: 'not_started', stepName: 'work' }, { status: 'in_progress', stepName: 'work' });
    await recording.report(1, hookInput.sessionStart(session, 'startup'));
    if (injected) sessions.injected('original request', { submitted: true });
    appendFileSync(session.transcriptPath, transcriptText([transcriptUserEntry({ ...session, promptId: 'first', uuid: 'entry', text: 'original request', timestamp: now.toISOString(), source: { kind: 'typed' } })]));
    await recording.report(1, hookInput.userPromptSubmit(session, 'first', 'original request'));
    appendFileSync(session.transcriptPath, transcriptText([queued]));
    if (makeCall) await sessions.observe(1, ({ origin, prompt }) => audit.recordMcpCall(repo, 'approve', origin, prompt, async () => ({ kind: origin === 'human' ? 'taken' : 'not-human-started' })));
    await recording.observe();
    await recording.report(1, hookInput.stop(session));
    await recording.close();
    const prompts = events().filter(e => e.type === 'mcp.prompt');
    expect(prompts.map(p => p.text)).toEqual(injected ? [queued.attachment.prompt] : ['original request', queued.attachment.prompt]);
    const message = prompts.find(p => p.text === queued.attachment.prompt)!;
    expect(message.ts).toBe(queued.attachment.timestamp);
    const call = events().find(e => e.mcp?.tool === 'approve')?.mcp;
    if (makeCall) {
      expect(call).toMatchObject({ origin: injected ? 'not-human' : 'human', outcome: injected ? 'not-human-started' : 'taken' });
      expect(call!.promptId).toBe(injected ? undefined : message.id);
    } else expect(call).toBeUndefined();
  } finally { await recording.close(); }
});

it.each(['duplicate', 'sidechain', 'generated', 'unknown', 'injected', 'injected hook', 'later turn', 'malformed'])('handles %s queued evidence without inventing human prompts', async variant => {
  const root = mkdtempSync(join(tmpdir(), 'queued-evidence-')); roots.push(root);
  const session = { sessionId: 'session', transcriptPath: join(root, 'transcript.jsonl'), cwd: root };
  const sessions = createSessionTurns({ launchOf: async () => ({ print: false, launchPrompt: false }) });
  const initial = transcriptUserEntry({ ...session, promptId: 'first', uuid: 'entry', text: 'original', timestamp: '2026-11-17T21:42:00Z', source: { kind: 'typed' } });
  appendFileSync(session.transcriptPath, transcriptText([initial]));
  sessions.hook(1, hookInput.sessionStart(session, 'startup'));
  sessions.hook(1, hookInput.userPromptSubmit(session, 'first', 'original'));
  await sessions.observe(1, () => {});
  await sessions.discoverHumanPrompts();
  const message = structuredClone(queued);
  if (variant === 'sidechain') message.isSidechain = true;
  if (variant === 'generated') message.attachment.origin.kind = 'scheduled';
  if (variant === 'unknown') message.attachment.origin.kind = 'future-origin';
  if (variant === 'malformed') message.attachment.timestamp = 'not a date';
  if (variant === 'injected' || variant === 'injected hook') sessions.injected(message.attachment.prompt, { submitted: true });
  if (variant === 'injected hook') sessions.hook(1, hookInput.userPromptSubmit(session, 'first', message.attachment.prompt));
  if (variant === 'later turn') appendFileSync(session.transcriptPath, transcriptText([{ ...initial, promptId: 'later', uuid: 'later-entry', message: { role: 'user', content: 'later' } }]));
  appendFileSync(session.transcriptPath, transcriptText([message, ...(variant === 'duplicate' ? [message] : [])]));
  const prompts = await sessions.discoverHumanPrompts();
  expect(prompts.map(p => p.text)).toEqual(variant === 'duplicate' ? ['original', queued.attachment.prompt] : ['original']);
  expect(await sessions.discoverHumanPrompts()).toEqual(prompts);
});
