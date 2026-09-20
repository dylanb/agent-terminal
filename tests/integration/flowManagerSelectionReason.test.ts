// A2 (#133) §18.7.6 — the flow manager decorates every view it returns with the resolver's `selectionReason`
// (the display-sanitized degrade reason), spliced FRESH at the FlowManager boundary on each call — never baked
// into the cached machine's closures, so a run whose reason changes without its definition changing reflects
// the new reason (the CWE-841 freeze the per-call splice prevents). Observable-behavior only: the reason on the
// returned FlowStateView, over the real machine.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFlowManager, loadFlowDefinition, type FlowLoad } from '../../src/main/flow';

const VALID = (name: string): string => `name: ${name}\nsteps:\n  - id: ${name}-step\n    kind: manual\n`;

describe('flow manager splices the resolver selectionReason onto the view (§18.7.6)', () => {
  let repo: string;
  let home: string;
  let okLoad: FlowLoad;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'flow-reason-repo-'));
    home = mkdtempSync(join(tmpdir(), 'flow-reason-home-'));
    mkdirSync(join(repo, '.agent-terminal'), { recursive: true });
    writeFileSync(join(repo, '.agent-terminal', 'flow.yaml'), VALID('fallback'));
    okLoad = loadFlowDefinition(repo);
  });
  afterEach(() => {
    for (const d of [repo, home]) rmSync(d, { recursive: true, force: true });
  });

  it('carries the reason on a passive state view', () => {
    const mgr = createFlowManager({
      globalDir: home,
      loadDefinition: () => ({ load: okLoad, selectionReason: 'Selected flow degraded; running the default.' }),
    });
    expect(mgr.state(repo).selectionReason).toBe('Selected flow degraded; running the default.');
  });

  it('carries the reason on a transition view too (start), not only passive state', () => {
    const mgr = createFlowManager({
      globalDir: home,
      loadDefinition: () => ({ load: okLoad, selectionReason: 'degraded reason' }),
    });
    expect(mgr.start(repo).selectionReason).toBe('degraded reason');
  });

  it('omits selectionReason when the resolver returns none', () => {
    const mgr = createFlowManager({ globalDir: home, loadDefinition: () => ({ load: okLoad }) });
    expect(mgr.state(repo).selectionReason).toBeUndefined();
  });

  it('re-reads the reason per call — a changed reason (same definition) is not frozen in the cached machine', () => {
    let reason: string | undefined = 'first';
    const mgr = createFlowManager({
      globalDir: home,
      loadDefinition: () => ({ load: okLoad, selectionReason: reason }),
    });
    expect(mgr.state(repo).selectionReason).toBe('first');
    reason = 'second';
    expect(mgr.state(repo).selectionReason).toBe('second');
    reason = undefined;
    expect(mgr.state(repo).selectionReason).toBeUndefined();
  });
});
