import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dump } from 'js-yaml';
import { createAuditRecorder } from '../../src/main/auditRecorder';
import { auditFilePath } from '../../src/main/auditPaths';
import { parseAuditStream } from '../../src/shared/audit';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const temp = (): string => { const root = mkdtempSync(join(tmpdir(), 'mcp-audit-')); roots.push(root); return root; };
const before = { status: 'not_started' as const, stepName: 'work' };
const after = { status: 'in_progress' as const, stepName: 'work' };

it('settles a call in its original run before finalization even if a replacement run opens', async () => {
  const root = temp(); const repo = temp();
  let now = new Date('2026-11-09T12:00:00Z');
  const audit = createAuditRecorder({ root, now: () => now, flowName: () => 'work' });
  audit.recordTransition(repo, 'start', before, after);
  const first = auditFilePath(root, repo, 'work', now);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const call = audit.recordMcpCall(repo, 'read_state', 'human', null, async () => {
    await held;
    audit.recordCommand(repo, 'gate', 'original operation settled', 0);
    return { kind: 'success' };
  });
  audit.recordTerminate(repo);
  now = new Date('2026-11-09T12:00:01Z');
  audit.recordTransition(repo, 'start', before, after);
  const second = auditFilePath(root, repo, 'work', now);
  release();
  await expect(call).resolves.toEqual({ kind: 'success' });
  const original = parseAuditStream(readFileSync(first, 'utf8')).events;
  expect(original.map(e => e.type)).toEqual(['flow.started', 'command', 'mcp.call', 'flow.terminated']);
  expect(original[1]).toMatchObject({ cmd: 'original operation settled' });
  expect(parseAuditStream(readFileSync(second, 'utf8')).events.map(e => e.type)).toEqual(['flow.started']);
});

for (const symlink of [false, true]) {
  it(`refuses a resumed audit destination outside its owned root${symlink ? ' through a symlink' : ''} without changing the action result`, async () => {
    const root = temp(); const repo = temp(); const outside = join(temp(), 'private.txt');
    writeFileSync(outside, 'unchanged');
    const file = symlink ? join(root, 'redirect.yaml') : outside;
    if (symlink) symlinkSync(outside, file);
    mkdirSync(join(repo, '.agent-terminal'));
    writeFileSync(join(repo, '.agent-terminal/audit-pointer.yaml'), dump({ file }));
    const audit = createAuditRecorder({ root, now: () => new Date(), flowName: () => 'work', log: () => {} });
    const result = { outcome: 'refusal', kind: 'not-human-started', message: 'Not a human-started turn' };
    await expect(audit.recordMcpCall(repo, 'approve', 'not-human', null, async () => result)).resolves.toEqual(result);
    expect(readFileSync(outside, 'utf8')).toBe('unchanged');
  });
}

it('records an MCP Start in the run it actually opens when the earlier run ended during its guard', async () => {
  const root = temp(); const repo = temp();
  let now = new Date('2026-11-09T12:00:00Z');
  const audit = createAuditRecorder({ root, now: () => now, flowName: () => 'work' });
  audit.recordTransition(repo, 'start', before, after);
  const first = auditFilePath(root, repo, 'work', now);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const call = audit.recordMcpCall(repo, 'start', 'human', null, async () => {
    await held;
    audit.recordTransition(repo, 'start', before, after);
    return { kind: 'taken' };
  });
  audit.recordTerminate(repo);
  now = new Date('2026-11-09T12:00:01Z');
  const second = auditFilePath(root, repo, 'work', now);
  release(); await call;
  expect(parseAuditStream(readFileSync(first, 'utf8')).events.map(e => e.type)).toEqual(['flow.started', 'flow.terminated']);
  expect(parseAuditStream(readFileSync(second, 'utf8')).events).toMatchObject([{ type: 'flow.started', mcp: { tool: 'start', outcome: 'taken' } }]);
});

it('includes the original prompt as context when a later call occurs inside a UI-opened run', async () => {
  const root = temp(); const repo = temp();
  const now = new Date('2026-11-09T12:00:00Z');
  const audit = createAuditRecorder({ root, now: () => now, flowName: () => 'work' });
  const prompt = { type: 'mcp.prompt' as const, id: 'outside-prompt', text: 'original request', ts: '2026-11-09T11:59:00Z' };
  audit.beginPrompt(repo, prompt);
  audit.recordTransition(repo, 'start', before, after);
  audit.recordPrompt(prompt);
  const file = auditFilePath(root, repo, 'work', now);
  expect(parseAuditStream(readFileSync(file, 'utf8')).events.map(e => e.type)).toEqual(['flow.started']);
  await audit.recordMcpCall(repo, 'read_state', 'human', prompt, async () => ({ kind: 'success' }));
  expect(parseAuditStream(readFileSync(file, 'utf8')).events).toMatchObject([
    { type: 'flow.started' }, prompt, { type: 'mcp.call', mcp: { promptId: prompt.id, outcome: 'success' } },
  ]);
});


it('retries a buffered original prompt after audit storage recovers within the same turn', async () => {
  const root = temp(); const repo = temp();
  const now = new Date('2026-11-09T12:00:00Z');
  const audit = createAuditRecorder({ root, now: () => now, flowName: () => 'work', log: () => {} });
  const prompt = { type: 'mcp.prompt' as const, id: 'recover-prompt', text: 'original request', ts: now.toISOString() };
  const file = auditFilePath(root, repo, 'work', now);
  audit.beginPrompt(repo, prompt);
  await expect(audit.recordMcpCall(repo, 'start', 'human', prompt, async () => {
    audit.recordTransition(repo, 'start', before, after);
    renameSync(file, `${file}.saved`);
    mkdirSync(file);
    return { kind: 'taken' };
  })).resolves.toEqual({ kind: 'taken' });
  rmSync(file, { recursive: true });
  renameSync(`${file}.saved`, file);
  await audit.recordMcpCall(repo, 'read_state', 'human', prompt, async () => ({ kind: 'success' }));
  const events = parseAuditStream(readFileSync(file, 'utf8')).events;
  expect(events.filter(e => e.type === 'mcp.prompt')).toEqual([prompt]);
  expect(events.at(-1)).toMatchObject({ type: 'mcp.call', mcp: { promptId: prompt.id } });
});


it('finishes asynchronous prompt discovery in its original run across hook cleanup and replacement Start', async () => {
  const root = temp(); const repo = temp();
  let now = new Date('2026-11-09T12:00:00Z');
  const audit = createAuditRecorder({ root, now: () => now, flowName: () => 'work' });
  audit.recordTransition(repo, 'start', before, after);
  const original = auditFilePath(root, repo, 'work', now);
  const prompt = { type: 'mcp.prompt' as const, id: 'pending-prompt', text: 'original request', ts: now.toISOString() };
  audit.beginPrompt(repo, prompt);
  let resolve!: (prompts: typeof prompt[]) => void;
  const discovery = new Promise<typeof prompt[]>(done => { resolve = done; });
  const recording = audit.recordPrompts(discovery);
  audit.forgetPrompt(prompt);
  audit.recordTerminate(repo);
  now = new Date('2026-11-09T12:00:01Z');
  audit.recordTransition(repo, 'start', before, after);
  const replacement = auditFilePath(root, repo, 'work', now);
  resolve([prompt]);
  await recording;
  expect(parseAuditStream(readFileSync(original, 'utf8')).events).toEqual([
    expect.objectContaining({ type: 'flow.started' }), prompt, expect.objectContaining({ type: 'flow.terminated' }),
  ]);
  expect(parseAuditStream(readFileSync(replacement, 'utf8')).events.map(e => e.type)).toEqual(['flow.started']);
});

it('finishes the original audit run when pending discovery rejects', async () => {
  const root = temp(); const repo = temp();
  const now = new Date('2026-11-09T12:00:00Z');
  const audit = createAuditRecorder({ root, now: () => now, flowName: () => 'work', log: () => {} });
  audit.recordTransition(repo, 'start', before, after);
  audit.beginPrompt(repo, { type: 'mcp.prompt', id: 'failed-prompt', text: 'request', ts: now.toISOString() });
  let reject!: (error: Error) => void;
  const recording = audit.recordPrompts(new Promise((_resolve, fail) => { reject = fail; }));
  audit.recordTerminate(repo);
  reject(new Error('transcript unavailable'));
  await expect(recording).resolves.toBeUndefined();
  expect(parseAuditStream(readFileSync(auditFilePath(root, repo, 'work', now), 'utf8')).events.map(e => e.type)).toEqual(['flow.started', 'flow.terminated']);
});
