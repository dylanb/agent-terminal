import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAuditRecorder } from '../../src/main/auditRecorder';
import { auditRootDir } from '../../src/main/auditPaths';
import { createFlowStateStore } from '../../src/main/flowState';
import { readCurrentAudit } from '../../src/main/finalizeAccess';
import { resolveAppHome } from '../../src/main/launchRoot';

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it('reads the recorder history from the app home instead of a same-run log in the shell home', () => {
  const root = mkdtempSync(join(tmpdir(), 'finalize-home-'));
  roots.push(root);
  const home = join(root, 'shell-home');
  const appHome = join(root, 'app-home');
  const repo = realpathSync(mkdtempSync(join(root, 'repo-')));
  vi.stubEnv('HOME', home);
  vi.stubEnv('APP_HOME_DIR', appHome);
  const flow = 'feature-dev-v3';
  const startedAt = Date.parse('2026-10-24T10:00:00.684Z');
  createFlowStateStore(repo).write({ step: 'finalize', status: 'in_progress', flow, startedAt });
  for (const [location, step] of [[home, 'wrong-home'], [resolveAppHome(process.env, home), 'finalize']]) {
    const recorder = createAuditRecorder({ root: auditRootDir(location), now: () => new Date(startedAt), flowName: () => flow });
    recorder.recordTransition(repo, 'start', { status: 'not_started', stepName: step }, { status: 'in_progress', stepName: step }, { flow, startedAt });
  }

  expect(readCurrentAudit(repo)).toMatchObject({
    coverage: 'complete',
    visits: [{ step: 'finalize', exited: null, elapsedMs: null }],
  });
});
