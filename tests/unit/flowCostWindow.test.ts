import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFlowManager } from '../../src/main/flow';

// §27.11 — the meter never reads flow state: every change to the run window or to engine selection reaches
// it as a value it is HANDED, deduped so an unchanged value reaches it not at all. The pushed value is a
// TRIPLE — the repo, the selected `app` loop's name or null, and the run window — because the same field
// answers both "is §27 the engine here" and "which loop is this".

interface Push {
  repoKey: string;
  loop: string | null;
  startedAt: number | null;
}

const APP_STEP = (id: string, loop: string): string =>
  `  - id: ${id}\n    kind: loop\n    loop: ${loop}\n    loop_namespace: app\n`;
const LEGACY_STEP = (id: string, loop: string): string => `  - id: ${id}\n    kind: loop\n    loop: ${loop}\n`;
const MANUAL_STEP = (id: string): string => `  - id: ${id}\n    kind: manual\n`;

let dirs: string[] = [];
let pushes: Push[] = [];
let clock = 5_000;

function seedRepo(steps: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'flow-cost-window-'));
  dirs.push(dir);
  mkdirSync(join(dir, '.agent-terminal'), { recursive: true });
  writeFileSync(join(dir, '.agent-terminal', 'flow.yaml'), `name: cost\nsteps:\n${steps}`);
  return dir;
}

function manager(
  push: (repoKey: string, loop: string | null, startedAt: number | null) => void = (repoKey, loop, startedAt) =>
    void pushes.push({ repoKey, loop, startedAt }),
): ReturnType<typeof createFlowManager> {
  return createFlowManager({
    globalDir: join(tmpdir(), 'flow-cost-window-global-does-not-exist'),
    now: () => clock,
    // A §27 provider must exist or the flow renders no loop view; its content is irrelevant here.
    readAppLoopView: () => ({ status: 'not-started', pr: null, branch: null, ready: false, actionable: false, humanNeeded: false }),
    pushCostWindow: push,
  });
}

beforeEach(() => {
  dirs = [];
  pushes = [];
  clock = 5_000;
});
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe('the window push the §27 meter is handed', () => {
  it('pushes the selected app loop and the new floor on start, and clears both on terminate', () => {
    const repo = seedRepo(APP_STEP('plan', 'plan-loop'));
    const flow = manager();
    flow.state(repo);
    expect(pushes).toEqual([{ repoKey: repo, loop: null, startedAt: null }]);

    flow.start(repo);
    expect(pushes.at(-1)).toEqual({ repoKey: repo, loop: 'plan-loop', startedAt: 5_000 });

    flow.terminate(repo);
    expect(pushes.at(-1)).toEqual({ repoKey: repo, loop: null, startedAt: null });
  });

  it('pushes the new floor on restart', () => {
    const repo = seedRepo(APP_STEP('plan', 'plan-loop'));
    const flow = manager();
    flow.start(repo);
    flow.advance(repo); // the only step → done
    clock = 9_000;
    flow.restart(repo);
    expect(pushes.at(-1)).toEqual({ repoKey: repo, loop: 'plan-loop', startedAt: 9_000 });
  });

  it('clears the window when a step revert lands in not_started', () => {
    const repo = seedRepo(APP_STEP('plan', 'plan-loop'));
    const flow = manager();
    flow.start(repo);
    flow.revertStep(repo, 'plan');
    expect(pushes.at(-1)).toEqual({ repoKey: repo, loop: null, startedAt: null });
  });

  // The floor-only dedup's blind spot, and the reason the pushed value is a triple: an advance from a
  // `manual` first step onto the `app` loop step leaves the recorded floor untouched — only the selection
  // flips — so a floor-keyed push fires NOTHING and the meter never activates for the whole run.
  it('pushes when an advance flips engine selection with the floor unchanged', () => {
    const repo = seedRepo(MANUAL_STEP('spec') + APP_STEP('plan', 'plan-loop'));
    const flow = manager();
    flow.start(repo);
    expect(pushes.at(-1)).toEqual({ repoKey: repo, loop: null, startedAt: 5_000 });

    flow.advance(repo);
    expect(pushes.at(-1)).toEqual({ repoKey: repo, loop: 'plan-loop', startedAt: 5_000 });
  });

  it('pushes a null loop when an advance leaves the app namespace for a legacy step', () => {
    const repo = seedRepo(APP_STEP('plan', 'plan-loop') + LEGACY_STEP('impl', 'impl-loop'));
    const flow = manager();
    flow.start(repo);
    expect(pushes.at(-1)?.loop).toBe('plan-loop');
    flow.advance(repo);
    expect(pushes.at(-1)).toEqual({ repoKey: repo, loop: null, startedAt: 5_000 });
  });

  // The shipped chain runs groom-loop → plan-loop → impl-loop, three distinct names all bound to `app`, so
  // a chain advance changes the pushed triple. A boolean-valued push cannot see this transition at all.
  it('pushes the new loop name on a chain advance between two app steps', () => {
    const repo = seedRepo(APP_STEP('plan', 'plan-loop') + APP_STEP('impl', 'impl-loop'));
    const flow = manager();
    flow.start(repo);
    flow.advance(repo);
    expect(pushes.at(-1)).toEqual({ repoKey: repo, loop: 'impl-loop', startedAt: 5_000 });
  });

  // The triple is deduped in ONE place — the meter, which is keyed by repo and outlives a flow.yaml edit
  // that rebuilds the machine. The manager forwards every render's value unchanged, so a re-read hands the
  // meter the same triple rather than nothing.
  it('forwards the same triple on every re-read rather than deduping it here', () => {
    const repo = seedRepo(APP_STEP('plan', 'plan-loop'));
    const flow = manager();
    flow.start(repo);
    const live = { repoKey: repo, loop: 'plan-loop', startedAt: 5_000 };
    expect(pushes.at(-1)).toEqual(live);
    pushes = [];
    for (let i = 0; i < 10; i += 1) flow.state(repo);
    expect(pushes).toHaveLength(10);
    expect(pushes.every((p) => p.repoKey === live.repoKey && p.loop === live.loop && p.startedAt === live.startedAt)).toBe(true);
  });

  it('forwards the unchanged triple after an undo that moves neither the window nor the selection', () => {
    const repo = seedRepo(APP_STEP('plan', 'plan-loop'));
    const flow = manager();
    flow.start(repo);
    flow.advance(repo);
    pushes = [];
    flow.undo(repo);
    expect(pushes.at(-1)).toEqual({ repoKey: repo, loop: 'plan-loop', startedAt: 5_000 });
  });

  // AC 7 — cost never gates, pauses, delays or fails a flow advance. The push sits inside the view every
  // transition returns through, so a sink that throws would take the operator's transition down with it.
  it('leaves every transition intact when the meter it pushes to throws', () => {
    const repo = seedRepo(APP_STEP('plan', 'plan-loop') + APP_STEP('impl', 'impl-loop'));
    const flow = manager(() => {
      throw new Error('meter gone');
    });
    expect(() => flow.state(repo)).not.toThrow();
    expect(flow.state(repo).status).toBe('not_started');
    expect(flow.start(repo).status).toBe('in_progress');
    expect(flow.advance(repo).stepName).toBe('impl');
    expect(flow.terminate(repo).status).toBe('not_started');
  });

  // After a relaunch there is no prior pushed value to differ from: the hydrate's restore is what hands the
  // meter the floor it must resume the run's total from.
  it('hands the meter the floor a relaunch restored, without any transition running', () => {
    const repo = seedRepo(APP_STEP('plan', 'plan-loop'));
    writeFileSync(
      join(repo, '.agent-terminal', 'flow-state.yaml'),
      'step: plan\nstatus: in_progress\nstarted_at: 4242\n',
    );
    const flow = manager();
    flow.state(repo);
    expect(pushes).toEqual([{ repoKey: repo, loop: 'plan-loop', startedAt: 4242 }]);
  });

  it('pushes the new floor when flow-state.yaml is rewritten out of process', () => {
    const repo = seedRepo(APP_STEP('plan', 'plan-loop'));
    const stateFile = join(repo, '.agent-terminal', 'flow-state.yaml');
    writeFileSync(stateFile, 'step: plan\nstatus: in_progress\nstarted_at: 4242\n');
    const flow = manager();
    flow.state(repo);
    writeFileSync(stateFile, 'step: plan\nstatus: in_progress\nstarted_at: 9999\n');
    flow.state(repo);
    expect(pushes.at(-1)).toEqual({ repoKey: repo, loop: 'plan-loop', startedAt: 9999 });
  });

  it('keys every push on its repo, so one repo`s clear leaves another`s untouched', () => {
    const a = seedRepo(APP_STEP('plan', 'plan-loop'));
    const b = seedRepo(APP_STEP('plan', 'plan-loop'));
    const flow = manager();
    flow.start(a);
    flow.start(b);
    pushes = [];
    flow.terminate(a);
    expect(pushes).toEqual([{ repoKey: a, loop: null, startedAt: null }]);
  });

  // A `legacy`-bound flow pushes exactly as an `app`-bound one does — the flow manager is engine-neutral —
  // so the push has to say which engine it is for or the §27 meter runs over a §26 run.
  it('pushes a null loop for a legacy-bound flow carrying a real floor', () => {
    const repo = seedRepo(LEGACY_STEP('plan', 'plan-loop'));
    const flow = manager();
    flow.start(repo);
    expect(pushes.every((p) => p.loop === null)).toBe(true);
    expect(pushes.at(-1)).toEqual({ repoKey: repo, loop: null, startedAt: 5_000 });
  });
});
