import { createMcpCallHandler } from '../../src/main/mcpCallHandler';
import { createSessionTurns } from '../../src/main/mcpSessionTurns';
import { hookInput } from '../helpers/fakeClaude';
import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAuditRecorder } from '../../src/main/auditRecorder';
import { mcpActions as createMcpActions, testGateOperations } from '../helpers/mcpActions';
import { auditFilePath } from '../../src/main/auditPaths';
import { parseAuditStream } from '../../src/shared/audit';
import type { TurnOrigin } from '../../src/shared/turnOrigin';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
for (const actual of ['not-human', 'undetermined'] as const) {
  it(`attributes a guarded refusal to its operation-time ${actual} turn from the same observation used to authorize the action`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'mcp-origin-')); roots.push(root);
    const repo = mkdtempSync(join(tmpdir(), 'mcp-origin-repo-')); roots.push(repo);
    const now = new Date('2026-11-09T12:00:00Z');
    const audit = createAuditRecorder({ root, now: () => now, flowName: () => 'work' });
    audit.recordTransition(repo, 'start', { status: 'not_started', stepName: 'work' }, { status: 'in_progress', stepName: 'work' });
    const prompt = { id: 'original-human', turnId: 'original-human', text: 'approve', occurredAt: now.toISOString() };
    audit.beginPrompt(repo, prompt);
    const deps = {
      windowId: 'window-1',
      originOf: async (): Promise<TurnOrigin> => actual,
      readState: async (): Promise<never> => { throw new Error('a refused call must not read action state'); },
      readActionState: (): never => { throw new Error('a refused call must not read action state'); },
      gate: testGateOperations({ pickupHold: () => null, approve: async (): Promise<never> => { throw new Error('a refused call must not approve'); } }),
    };
    const actions = createMcpActions(deps);
    const session = { sessionId: 'caller', transcriptPath: '/owned/transcript', cwd: repo };
    const turns = createSessionTurns({ launchOf: async () => ({ print: false, launchPrompt: false }), observeTranscript: async () => ({ origin: actual, version: '1' }) });
    turns.hook(1001, hookInput.sessionStart(session, 'startup'));
    turns.hook(1001, hookInput.userPromptSubmit(session, 'prompt', 'approve'));
    const call = createMcpCallHandler({ repo: () => repo, sessions: turns, audit, actions });
    const result = await call({ tool: 'approve', args: { window: 'window-1', repo, step: 'work', turn: 'turn-1' } }, { session: 1001 });
    expect(result).toMatchObject({ outcome: 'refusal', kind: actual === 'not-human' ? 'not-human-started' : 'origin-undetermined' });
    const entries = parseAuditStream(readFileSync(auditFilePath(root, repo, 'work', now), 'utf8')).events.filter(e => e.mcp);
    expect(entries).toHaveLength(1);
    expect(entries[0].mcp).toMatchObject({ origin: actual, outcome: actual === 'not-human' ? 'not-human-started' : 'origin-undetermined' });
    expect(entries[0].mcp?.promptId).toBeUndefined();
  });
}

it('keeps concurrent calls attached to their own observed prompts, including a wrong-window refusal', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mcp-origin-')); roots.push(root);
  const repo = mkdtempSync(join(tmpdir(), 'mcp-origin-repo-')); roots.push(repo);
  const now = new Date('2026-11-11T12:00:00Z');
  const audit = createAuditRecorder({ root, now: () => now, flowName: () => 'work' });
  audit.recordTransition(repo, 'start', { status: 'not_started', stepName: 'work' }, { status: 'in_progress', stepName: 'work' });
  const turns = createSessionTurns({ launchOf: async () => ({ print: false, launchPrompt: false }), observeTranscript: async () => ({ origin: 'human', version: '1' }) });
  for (const id of [1, 2]) {
    const session = { sessionId: `caller-${id}`, transcriptPath: `/owned/${id}`, cwd: repo };
    turns.hook(id, hookInput.sessionStart(session, 'startup'));
    turns.hook(id, hookInput.userPromptSubmit(session, `prompt-${id}`, `human ${id}`));
  }
  const state = { window: { id: 'window-1' }, repo: { key: repo }, flow: null, selectionUnusable: false, gate: null,
    stalledTurn: null, loopMessage: null, roundReport: null, todos: [], startable: [], startableError: null, terminateTodoCount: null };
  const actions = createMcpActions({ windowId: 'window-1', originOf: async () => { throw new Error('origin must come from the shared observation'); },
    readState: async () => state, readActionState: () => state,
    gate: { pickupHold: () => null, refusal: () => null, approve: async () => ({ kind: 'refused', reason: 'no gate' }), decide: async () => ({ taken: false, reason: 'no gate' }) },
  });
  const call = createMcpCallHandler({ repo: () => repo, sessions: turns, audit, actions });
  const results = await Promise.all([
    call({ tool: 'read_state', args: {} }, { session: 1 }),
    call({ tool: 'approve', args: { window: 'other', repo, step: 'work' } }, { session: 2 }),
  ]);
  expect(results[0]).toMatchObject({ window: { id: 'window-1' } });
  expect(results[1]).toMatchObject({ outcome: 'refusal', kind: 'not-this-window' });
  const events = parseAuditStream(readFileSync(auditFilePath(root, repo, 'work', now), 'utf8')).events;
  const prompts = events.filter(event => event.type === 'mcp.prompt');
  const calls = events.filter(event => event.mcp);
  expect(calls).toHaveLength(2);
  for (const [tool, text] of [['read_state', 'human 1'], ['approve', 'human 2']]) {
    const prompt = prompts.find(event => event.text === text);
    expect(prompt).toBeDefined();
    expect(calls.find(event => event.mcp?.tool === tool)?.mcp).toMatchObject({ origin: 'human', promptId: prompt!.id });
  }
});
