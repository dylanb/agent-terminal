import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseAgentLoopState } from '../../src/main/agentLoopBridge';
import { parseLoopDef } from '../../src/main/loopDef';
import { deriveLoopView } from '../../src/main/flow';
import { createLoopNotifier, type LoopNotifyOpts } from '../../src/main/loopNotifier';
import type { FlowStateView } from '../../src/shared/ipc';

// §24.2.3 T4 — the OS-notification decision driven END-TO-END from a real state.yaml + LoopDef on
// disk, asserting the file content alone drives raise/dedup/clear. Real temp files (parser and
// derivation unmocked); only the OS-notification surface is spied (CLAUDE.md permits it).

const IMPL_LOOP =
  'name: impl-loop\n' +
  'schema_version: "4"\n' +
  'gates:\n' +
  '  - id: awaiting-human-pr-approval\n    kind: approve-required\n    human_options: [approve, request-changes, impasse]\n' +
  '  - id: awaiting-human-impl-triage\n    kind: triage\n    human_options: [approve, request-changes, impasse]\n' +
  '  - id: impl-draft\n    kind: in-flight\n    human_options: [impasse]\n' +
  '  - id: awaiting-team-review\n    kind: terminal\n    human_options: []\n' +
  '  - id: impasse\n    kind: terminal\n    human_options: []\n';

const BASE: FlowStateView = { stepName: 'build', steps: ['build'], position: 1, total: 1, status: 'in_progress' };

describe('loop notifier driven from real state.yaml (§24.2.3 T4)', () => {
  let repo: string;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'loopnotify-'));
    mkdirSync(join(repo, '.agent-loop'), { recursive: true });
    writeFileSync(join(repo, 'impl-loop.yaml'), IMPL_LOOP);
    writeFileSync(join(repo, '.agent-loop.yaml'), 'loops:\n  impl-loop: ./impl-loop.yaml\n');
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  const writeState = (status: string, iteration: number): void =>
    writeFileSync(
      join(repo, '.agent-loop', 'state.yaml'),
      `schema_version: 4\npr: 179\nbranch: b\niteration: ${iteration}\nstatus: ${status}\n`,
    );
  const viewNow = (): FlowStateView =>
    deriveLoopView(BASE, parseAgentLoopState(repo), parseLoopDef(repo, 'impl-loop'));

  function spyNotifier(focused = false) {
    const notify = vi.fn<(o: LoopNotifyOpts) => () => void>(() => () => {});
    return { notify, notifier: createLoopNotifier({ isFocused: () => focused, notify, focusWindow: vi.fn(), reveal: vi.fn() }) };
  }

  it('raises on a real awaiting-human state.yaml when unfocused', () => {
    writeState('awaiting-human-pr-approval', 9);
    const { notifier, notify } = spyNotifier();
    notifier.observe(repo, viewNow());
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('does not raise on a real terminal hand-off state.yaml', () => {
    writeState('awaiting-team-review', 9);
    const { notifier, notify } = spyNotifier();
    notifier.observe(repo, viewNow());
    expect(notify).not.toHaveBeenCalled();
  });

  it('re-raises when the human-needed status advances in a later iteration', () => {
    const { notifier, notify } = spyNotifier();
    writeState('awaiting-human-pr-approval', 9);
    notifier.observe(repo, viewNow());
    writeState('awaiting-human-impl-triage', 11);
    notifier.observe(repo, viewNow());
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it('clears the notification when the mirror becomes a null mirror (corrupt state.yaml)', () => {
    const close = vi.fn();
    const notify = vi.fn<(o: LoopNotifyOpts) => () => void>(() => close);
    const notifier = createLoopNotifier({ isFocused: () => false, notify, focusWindow: vi.fn(), reveal: vi.fn() });
    writeState('awaiting-human-pr-approval', 9);
    notifier.observe(repo, viewNow());
    writeFileSync(join(repo, '.agent-loop', 'state.yaml'), 'schema_version: 99\n: not: valid');
    notifier.observe(repo, viewNow()); // null mirror → no loop on the view
    expect(close).toHaveBeenCalledTimes(1);
  });
});
