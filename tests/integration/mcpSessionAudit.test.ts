import { expect, it } from 'vitest';
import { createMcpSessionAudit } from '../../src/main/mcpSessionAudit';
import { createSessionTurns } from '../../src/main/mcpSessionTurns';
import { createAuditRecorder } from '../../src/main/auditRecorder';
import { parseAuditStream } from '../../src/shared/audit';
import { auditFilePath } from '../../src/main/auditPaths';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hookInput } from '../helpers/fakeClaude';

it('records human prompts across hook lifecycle boundaries without caller-managed audit bookkeeping', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mcp-session-audit-'));
  const repo = join(root, 'repo');
  const now = new Date('2026-11-11T12:00:00Z');
  const sessions = createSessionTurns({ launchOf: async () => ({ print: false, launchPrompt: false }), observeTranscript: async () => ({ origin: 'human', version: '1' }) });
  const audit = createAuditRecorder({ root, now: () => now, flowName: () => 'work' });
  const recording = createMcpSessionAudit({ sessions, audit, repo: () => repo });
  const session = { sessionId: 'caller', transcriptPath: '/owned/transcript', cwd: repo };
  try {
    audit.recordTransition(repo, 'start', { status: 'not_started', stepName: 'work' }, { status: 'in_progress', stepName: 'work' });
    await recording.report(1, hookInput.sessionStart(session, 'startup'));
    await recording.report(1, hookInput.userPromptSubmit(session, 'first', 'human request'));
    await recording.report(1, hookInput.stop(session));
    await recording.close();
    const events = parseAuditStream(readFileSync(auditFilePath(root, repo, 'work', now), 'utf8')).events;
    expect(events.filter(event => event.type === 'mcp.prompt')).toMatchObject([{ text: 'human request' }]);
  } finally { await recording.close(); rmSync(root, { recursive: true, force: true }); }
});
