import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateShim, type LaunchInvocation } from '../../src/main/cliShim';
import { writeForegroundRecorder } from '../helpers/shimRecorder';

let root: string;
beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), 'reviewer-launcher-'))); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('terminal reviewer installation', () => {
  it.each(['packaged', 'development'] as const)('%s launcher returns the foreground install result to the calling terminal', (build) => {
    const recorder = writeForegroundRecorder(join(root, 'binary'), {
      stdout: 'created reviewer.md\n', stderr: 'destination unavailable\n', exitCode: 3,
    });
    const invocation: LaunchInvocation = {
      kind: 'binary', execPath: recorder.binary,
      appArgs: build === 'development' ? [join(root, 'index.js')] : [],
    };
    const shim = join(root, 'agent-terminal');
    writeFileSync(shim, generateShim(invocation, join(root, 'artifactCheck.js')));
    chmodSync(shim, 0o755);

    const result = spawnSync(shim, ['--install-reviewers', join(root, 'flow')], {
      cwd: root, encoding: 'utf8',
    });

    expect.soft({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual({
      status: 3, stdout: 'created reviewer.md\n', stderr: 'destination unavailable\n',
    });
    expect(recorder.read()).toEqual({
      argv: [join(root, 'artifactCheck.js'), '--install-reviewers', join(root, 'flow')],
      cwd: root, runAsNode: '1',
    });
  });
});
