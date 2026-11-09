import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAuditRecorder } from '../../src/main/auditRecorder';
import { createMcpActions } from '../../src/main/mcpActions';
import { auditFilePath } from '../../src/main/auditPaths';
import { parseAuditStream } from '../../src/shared/audit';
import { APP_LOOP_NAMESPACE } from '../../src/shared/loopNamespace';
import type { TurnOrigin } from '../../src/shared/turnOrigin';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
for (const actual of ['not-human', 'undetermined'] as const) {
  it(`attributes a guarded refusal to its operation-time ${actual} turn after the initial human observation changes`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'mcp-origin-')); roots.push(root);
    const repo = mkdtempSync(join(tmpdir(), 'mcp-origin-repo-')); roots.push(repo);
    const now = new Date('2026-11-09T12:00:00Z');
    const audit = createAuditRecorder({ root, now: () => now, flowName: () => 'work' });
    audit.recordTransition(repo, 'start', { status: 'not_started', stepName: 'work' }, { status: 'in_progress', stepName: 'work' });
    const prompt = { type: 'mcp.prompt' as const, id: 'original-human', text: 'approve', ts: now.toISOString() };
    audit.beginPrompt(repo, prompt);
    const deps = {
      windowId: 'window-1',
      originOf: async (): Promise<TurnOrigin> => actual,
      originObserved: (origin: TurnOrigin) => audit.observeMcpOrigin(origin, null),
      readState: async (): Promise<never> => { throw new Error('a refused call must not read action state'); },
      readGateState: (): never => { throw new Error('a refused call must not read action state'); },
      gate: {
        pickupHold: () => null,
        bindingOf: () => APP_LOOP_NAMESPACE,
        approve: async (): Promise<never> => { throw new Error('a refused call must not approve'); },
        autoGate: { humanDecision: () => () => {} },
      },
    };
    const actions = createMcpActions(deps);
    const result = await audit.recordMcpCall(repo, 'approve', 'human', prompt, () => actions.call({ tool: 'approve', args: { window: 'window-1', repo, step: 'work', turn: 'turn-1' } }, { session: 1001 }));
    expect(result).toMatchObject({ outcome: 'refusal', kind: actual === 'not-human' ? 'not-human-started' : 'origin-undetermined' });
    const entries = parseAuditStream(readFileSync(auditFilePath(root, repo, 'work', now), 'utf8')).events.filter(e => e.mcp);
    expect(entries).toHaveLength(1);
    expect(entries[0].mcp).toMatchObject({ origin: actual, outcome: actual === 'not-human' ? 'not-human-started' : 'origin-undetermined' });
    expect(entries[0].mcp?.promptId).toBeUndefined();
  });
}
