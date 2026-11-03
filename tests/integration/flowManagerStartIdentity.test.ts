import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createWorktreeFixture } from '../helpers/worktreeFixture';
import { createFlowManager, flowCatalogDir } from '../../src/main/flow';
import { createRunResolver } from '../../src/main/runResolver';
import { writeActiveFlow } from '../../src/main/activeFlowPointer';
import { createFlowStateStore } from '../../src/main/flowState';
import { createAuditRecorder } from '../../src/main/auditRecorder';
import { auditFilePath } from '../../src/main/auditPaths';
import { auditTimestamp, parseAuditStream } from '../../src/shared/audit';
import { createAutoGate } from '../../src/main/autoGate';
import { resolveRuntimeConfig } from '../../src/main/runtimeConfig';
import { composeRecordFlowTransition, composeStartTransition } from '../../src/main/autoGateComposition';
import { FLOW_DEF_FILE } from '../../src/main/flowHome';

// #137 — a run's identity (its flow's `name:` and its Start instant) is written into flow-state at Start and kept
// by every later transition, so the §25 file it names can be found again for the run's whole lifetime.
describe('flow-state keeps the run identity Start wrote (#137, §25)', () => {
  const fx = createWorktreeFixture();
  afterEach(() => fx.cleanup());

  const seedEntry = (root: string, id: string, name: string, ...steps: string[]): void => {
    const dir = join(flowCatalogDir(root), id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, FLOW_DEF_FILE), `name: ${name}\nsteps:\n` + steps.map((s) => `  - id: ${s}\n    kind: manual\n`).join(''));
  };

  const setup = (prefix: string) => {
    const wt = fx.makeWorktree(prefix);
    const globalDir = fx.makeWorktree(`${prefix}-global`);
    seedEntry(wt, 'auto-x', 'Auto X Flow', 'x-one', 'x-two', 'x-three');
    seedEntry(wt, 'flow-y', 'Flow Y', 'y-step');
    writeActiveFlow(wt, 'auto-x');
    const resolve = createRunResolver(globalDir);
    const mgr = createFlowManager({ globalDir, loadDefinition: (repoKey) => resolve(repoKey) });
    const persisted = () => createFlowStateStore(wt).read();
    return { wt, mgr, persisted, resolve };
  };

  it('Start records the flow `name:` (not the catalog id) and the Start instant, and advance keeps both, also after the pointer moves', () => {
    const { wt, mgr, persisted } = setup('s137-identity');
    const before = Date.now();
    mgr.start(wt);
    const after = Date.now();
    const started = persisted();
    expect(started?.flow).toBe('Auto X Flow');
    expect(started?.startedAt).toBeGreaterThanOrEqual(before);
    expect(started?.startedAt).toBeLessThanOrEqual(after);

    mgr.advance(wt);
    expect(persisted()).toMatchObject({ step: 'x-two', flow: 'Auto X Flow', startedAt: started?.startedAt });

    writeActiveFlow(wt, 'flow-y');
    mgr.advance(wt);
    expect(persisted()).toMatchObject({ step: 'x-three', flow: 'Auto X Flow', startedAt: started?.startedAt });
  });

  it('Undo and Restart of a finished run keep its Start identity', () => {
    const { wt, mgr, persisted } = setup('s137-identity-done');
    mgr.start(wt);
    const identity = { flow: persisted()?.flow, startedAt: persisted()?.startedAt };
    expect(identity.flow).toBe('Auto X Flow');
    mgr.advance(wt);
    mgr.advance(wt);
    mgr.advance(wt);
    expect(persisted()).toMatchObject({ status: 'done', ...identity });

    mgr.undo(wt);
    expect(persisted()).toMatchObject({ status: 'in_progress', ...identity });

    mgr.advance(wt);
    mgr.restart(wt);
    expect(persisted()).toMatchObject({ step: 'x-one', status: 'in_progress', ...identity });
  });

  // Plan "One Start timestamp": driven through the production Start → record composition with the Start clock
  // at `…x.999 s` and the recorder's `now` one second later, so a start leg stamped from the recorder's clock
  // fails every run rather than only when the two reads straddle a second.
  it('the composed Start names the §25 file and stamps flow-state from one Start instant and the flow `name:`', () => {
    const { wt, mgr, persisted, resolve } = setup('s137-identity-composed');
    const auditRoot = fx.outsideDir('s137-identity-audit');
    const startedAt = Date.parse('2026-07-17T12:00:01.999Z');
    const audit = createAuditRecorder({ root: auditRoot, now: () => new Date(startedAt + 1_000), flowName: () => 'auto-x' });
    const gate = createAutoGate({
      audit: () => {},
      resolveDef: () => null,
      currentRun: () => null,
      runInProgressAt: () => true,
      onViewChanged: () => {},
      emitError: () => {},
      setTimer: () => ({ id: 0 }),
      clearTimer: () => {},
      decisionBoundMs: resolveRuntimeConfig({}).autoGateDecisionMs,
      askAgentWhy: () => {},
      withdrawAgentQuestion: () => {},
      currentSlice: () => 1,
    });
    const flowStart = composeStartTransition({
      autoGate: gate,
      resolveForStart: (repoKey) => {
        const load = resolve(repoKey).load;
        if (!load.ok) throw new Error(load.error);
        return { definition: load.definition };
      },
      start: (repoKey, opts) => mgr.start(repoKey, opts),
      now: () => startedAt,
      record: composeRecordFlowTransition(audit, gate),
    });

    flowStart(wt);

    expect(persisted()).toMatchObject({ flow: 'Auto X Flow', startedAt });
    const file = auditFilePath(auditRoot, wt, 'Auto X Flow', new Date(startedAt));
    expect(existsSync(file)).toBe(true);
    expect(parseAuditStream(readFileSync(file, 'utf8')).header).toMatchObject({ flow: 'Auto X Flow', started: auditTimestamp(new Date(startedAt)) });
  });
});
