import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createWorktreeFixture } from '../helpers/worktreeFixture';
import { createFlowManager, flowHomeDir } from '../../src/main/flow';
import { activeFlowPointerFile, clearActiveFlow, readActiveFlow, writeActiveFlow } from '../../src/main/activeFlowPointer';
import { readRunBinding, runDispositionFile } from '../../src/main/runDisposition';
import { worktreeStartedness } from '../../src/main/startedness';

// §18.7.2 AC8 / CWE-59/73/400 — the app's own-files under <worktree>/.agent-terminal sit on untrusted ground: a
// leaf planted as a symlink to a sibling (or to the flow home itself), or as a FIFO, must never redirect a write
// or delete onto another app file, and must never block the main process on a read.
describe('own-file leaves under .agent-terminal resist planted links and FIFOs (§18.7.2 AC8)', () => {
  const fx = createWorktreeFixture();
  afterEach(() => fx.cleanup());

  const flowStateFile = (wt: string): string => join(flowHomeDir(wt), 'flow-state.yaml');

  it('Terminate with run-disposition.yaml linked to the flow home leaves the rest of .agent-terminal intact', () => {
    const wt = fx.makeWorktree('own-leaf-rm-home');
    const globalDir = fx.makeWorktree('own-leaf-rm-home-global');
    fx.writeFlowHome(wt, { name: 'local-flow', stepIds: ['red', 'green'] });
    const mgr = createFlowManager({ globalDir });
    mgr.start(wt);
    const keep = join(flowHomeDir(wt), 'keep.txt');
    writeFileSync(keep, 'keep');
    const marker = runDispositionFile(wt);
    execFileSync('rm', ['-f', marker]);
    symlinkSync('.', marker);

    mgr.terminate(wt);

    expect(existsSync(keep)).toBe(true);
    expect(existsSync(join(flowHomeDir(wt), 'flow.yaml'))).toBe(true);
  });

  it('Start with run-disposition.yaml linked to flow-state.yaml never overwrites the progression', () => {
    const wt = fx.makeWorktree('own-leaf-start-clobber');
    const globalDir = fx.makeWorktree('own-leaf-start-clobber-global');
    fx.writeFlowHome(wt, { name: 'local-flow', stepIds: ['red', 'green'] });
    fx.writeFlowState(wt, { step: 'red', status: 'not_started' });
    symlinkSync('flow-state.yaml', runDispositionFile(wt));
    const mgr = createFlowManager({ globalDir });

    mgr.start(wt);

    expect(readFileSync(flowStateFile(wt), 'utf8')).not.toContain('source:');
  });

  it('a pointer write or clear through active-flow.yaml linked to flow-state.yaml leaves flow-state.yaml untouched', () => {
    const wt = fx.makeWorktree('own-leaf-pointer-clobber');
    fx.writeFlowState(wt, { step: 'red', status: 'not_started' });
    const before = readFileSync(flowStateFile(wt));
    symlinkSync('flow-state.yaml', activeFlowPointerFile(wt));

    writeActiveFlow(wt, 'flow-x');
    expect(readFileSync(flowStateFile(wt))).toEqual(before);
  });

  it('clearing the pointer through active-flow.yaml linked to flow-state.yaml never deletes flow-state.yaml', () => {
    const wt = fx.makeWorktree('own-leaf-pointer-rm');
    fx.writeFlowState(wt, { step: 'red', status: 'not_started' });
    symlinkSync('flow-state.yaml', activeFlowPointerFile(wt));

    clearActiveFlow(wt);

    expect(existsSync(flowStateFile(wt))).toBe(true);
  });

  it('a FIFO planted at the pointer or the marker never blocks the read', () => {
    const wt = fx.makeWorktree('own-leaf-fifo');
    fx.writeFlowHome(wt, { name: 'local-flow', stepIds: ['red'] });
    execFileSync('mkfifo', [activeFlowPointerFile(wt)]);
    execFileSync('mkfifo', [runDispositionFile(wt)]);

    expect(readActiveFlow(wt).kind).toBe('invalid');
    expect(readRunBinding(wt)).toBeNull();
    expect(worktreeStartedness(wt)).not.toBe('never-started');
  });
});
