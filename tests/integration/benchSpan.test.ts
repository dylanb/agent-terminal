import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createBenchFixtureBuilder, type BenchFixtureBuilder } from '../helpers/benchFixtureBuilder';
import { createBenchRoots, type BenchRoots } from '../helpers/benchRoots';
import { createFakeLauncher } from '../helpers/benchFakeLauncher';
import { capturedSetup, FIXTURE_ARTIFACTS, handFields, runRequest, V3_FLOW } from '../helpers/benchRunSetup';
import { runBench } from '../../src/main/benchRun';
import { setupBenchLaunch, type BenchSpanPorts } from '../../src/main/benchSpan';
import { createFlowManager, type FlowManager } from '../../src/main/flow';
import { createFlowLifecycle, type FlowLifecycle } from '../../src/main/flowLifecycle';
import { createFlowStateStore } from '../../src/main/flowState';
import { createWorktreeLock } from '../../src/main/worktreeLock';
import { createRunResolver } from '../../src/main/runResolver';
import { encodeBenchLaunch, parseBenchSpanEnd, type BenchLaunch } from '../../src/shared/benchLaunch';

// #180 — the app side of the launch contract over a working folder the runner prepared: the span holds the launched
// folder's flow inside `first`..`last`, every ending is written once to the span-end file and quits the app, and
// every port but the window close acts for the launched folder alone.

let b: BenchFixtureBuilder;
let roots: BenchRoots;
afterEach(() => {
  b?.cleanup();
  roots?.cleanup();
});

/** A working folder the runner prepared for span `red`..`refactor`, from `fixtureFor`'s fixture or the captured one. */
async function prepared(fixtureFor?: (commit: string) => string): Promise<BenchLaunch> {
  b = createBenchFixtureBuilder();
  roots = createBenchRoots();
  const s = await capturedSetup(b, roots, 'bench-span');
  let launch: BenchLaunch | undefined;
  const launcher = createFakeLauncher({ inspect: (l) => (launch = l) });
  const result = await runBench(runRequest(fixtureFor ? { repo: s.repo, fixture: fixtureFor(s.commit) } : s, roots, {}, { launcher }));
  if (!result.ok || launch === undefined) throw new Error(`setup: the run was not prepared (${result.ok ? 'no launch' : result.code})`);
  return launch;
}

interface App {
  ports: BenchSpanPorts;
  quits: () => number;
  flow: FlowManager;
  entered: string[];
}

/** The launched app's ports for `launch`, and a flow manager under its span port that records each step entered. */
function launchedApp(launch: BenchLaunch): App {
  let quits = 0;
  const setup = setupBenchLaunch(encodeBenchLaunch(launch), launch.workingFolder, () => void quits++);
  if (!setup.ok || setup.ports === null) throw new Error('setup: the launch value was not honoured');
  const entered: string[] = [];
  const resolve = createRunResolver(roots.appHome);
  const flow = createFlowManager({
    globalDir: roots.appHome,
    loadDefinition: (k) => resolve(k),
    onEnterStep: (step) => void entered.push(step.id),
    span: setup.ports.span,
  });
  return { ports: setup.ports, quits: () => quits, flow, entered };
}

const ending = (launch: BenchLaunch): string | null => {
  if (!existsSync(launch.spanEndFile)) return null;
  const read = parseBenchSpanEnd(readFileSync(launch.spanEndFile, 'utf8'));
  return read.ok ? read.ending : `unparsable: ${read.reason}`;
};
const flowStateText = (dir: string): string => readFileSync(join(dir, '.agent-terminal', 'flow-state.yaml'), 'utf8');

function lifecycleOver(flow: FlowManager, ports: BenchSpanPorts): FlowLifecycle {
  const none = (): void => undefined;
  return createFlowLifecycle({
    lock: createWorktreeLock({ lockRoot: b.outsideDir('bench-span-locks'), holderLiveness: () => 'live-matching' }),
    flow,
    recovery: { rebind: () => ({ ok: false, reason: 'not under test' }) },
    pendingNotices: { post: none },
    loopTurnActive: () => false,
    forgetRunEntry: none,
    endRun: none,
    recordTerminate: none,
    spanTerminated: (k) => ports.terminated(k),
    clearTodos: none,
    clearSliceBrief: none,
    clearMonitor: none,
    flowChanged: none,
    releaseLoopTurn: none,
    presentView: (_k, view) => view,
  });
}

/** A repository outside the launch with feature-dev-v3 active at `refactor`, one slice, not yet started: once
 *  started, its next advance leaves a `red`..`refactor` span. */
function otherRepo(): string {
  const { dir } = b.makeRepository('bench-span-other');
  b.seedFlow(dir, 'feature-dev-v3', V3_FLOW);
  createFlowStateStore(dir).write({ step: 'refactor', status: 'not_started' });
  return dir;
}

describe('the launched span (#180)', () => {
  it('runs a fixture captured after infra with two slices through red, green, refactor twice, then leaves the span instead of entering integration-slice', async () => {
    const launch = await prepared();
    const app = launchedApp(launch);
    const wf = launch.workingFolder;

    app.flow.start(wf);
    for (let i = 0; i < 5; i++) app.flow.advance(wf);
    const before = flowStateText(wf);
    app.flow.advance(wf);

    expect({ entered: app.entered, step: app.flow.state(wf).stepName, persisted: flowStateText(wf), ending: ending(launch), quits: app.quits() }).toEqual({
      entered: ['red', 'green', 'refactor', 'red', 'green', 'refactor'],
      step: 'refactor',
      persisted: before,
      ending: 'left span',
      quits: 1,
    });
  });

  it('runs a fixture captured mid-loop, slice 1 counted and positioned at red, through one red, green, refactor, then leaves the span', async () => {
    const launch = await prepared((commit) => {
      const hand = join(b.outsideDir('bench-span-hand'), 'fx');
      b.writeHandFixture(hand, { ...handFields(commit), repeat_counts: { refactor: 2 } }, FIXTURE_ARTIFACTS);
      return hand;
    });
    const app = launchedApp(launch);
    const wf = launch.workingFolder;

    app.flow.start(wf);
    for (let i = 0; i < 3; i++) app.flow.advance(wf);

    expect({ entered: app.entered, step: app.flow.state(wf).stepName, ending: ending(launch), quits: app.quits() }).toEqual({
      entered: ['red', 'green', 'refactor'],
      step: 'refactor',
      ending: 'left span',
      quits: 1,
    });
  });

  it('writes only the first ending, so the window close the quit causes never overwrites it', async () => {
    const launch = await prepared();
    const app = launchedApp(launch);
    const wf = launch.workingFolder;

    app.ports.span.ended(wf, 'left span');
    app.ports.span.ended(wf, 'completed');
    app.ports.terminated(wf);
    app.ports.windowClosed();

    expect({ ending: ending(launch), quits: app.quits() }).toEqual({ ending: 'left span', quits: 1 });
  });

  it('writes terminated when a terminate through the lifecycle resets the run', async () => {
    const launch = await prepared();
    const app = launchedApp(launch);
    const wf = launch.workingFolder;
    app.flow.start(wf);

    const result = lifecycleOver(app.flow, app.ports).terminate(wf);

    expect({ outcome: result.outcome, ending: ending(launch), quits: app.quits() }).toEqual({ outcome: 'reset', ending: 'terminated', quits: 1 });
  });

  it('writes nothing for a terminate the lifecycle refuses', async () => {
    const launch = await prepared();
    const app = launchedApp(launch);

    const result = lifecycleOver(app.flow, app.ports).terminate(launch.workingFolder);

    expect({ outcome: result.outcome, ending: ending(launch), quits: app.quits() }).toEqual({ outcome: 'refused', ending: null, quits: 0 });
  });

  it('writes completed when the launched folder\'s flow completes inside the span', async () => {
    const launch = await prepared();
    const app = launchedApp(launch);

    app.ports.span.ended(launch.workingFolder, 'completed');

    expect({ ending: ending(launch), quits: app.quits() }).toEqual({ ending: 'completed', quits: 1 });
  });

  it('writes window closed when the operator closes the window, whatever folder the call names none of', async () => {
    const launch = await prepared();
    const app = launchedApp(launch);

    app.ports.windowClosed();

    expect({ ending: ending(launch), quits: app.quits() }).toEqual({ ending: 'window closed', quits: 1 });
  });

  it('still quits when the span-end file cannot be written', async () => {
    const launch = await prepared();
    const blocker = join(b.outsideDir('bench-span-blocked'), 'a-file');
    writeFileSync(blocker, '');
    const app = launchedApp({ ...launch, spanEndFile: join(blocker, 'span-end.json') });

    app.ports.span.ended(launch.workingFolder, 'left span');

    expect(app.quits()).toBe(1);
  });

  it('names the span for the launched folder alone', async () => {
    const launch = await prepared();
    const app = launchedApp(launch);
    const other = otherRepo();

    expect({ launched: app.ports.span.spanFor(launch.workingFolder), other: app.ports.span.spanFor(other) }).toEqual({ launched: launch.span, other: null });
  });

  it('maps a Start to the chain advance for the launched folder alone', async () => {
    const launch = await prepared();
    const app = launchedApp(launch);
    const other = otherRepo();

    expect({ launched: app.ports.startEntryFor(launch.workingFolder), other: app.ports.startEntryFor(other) }).toEqual({ launched: 'chain-advance', other: null });
  });

  it('ignores an ending or a terminate that names another folder, whose flow moves as today', async () => {
    const launch = await prepared();
    const app = launchedApp(launch);
    const other = otherRepo();

    app.flow.start(other);
    app.flow.advance(other);
    app.ports.span.ended(other, 'left span');
    app.ports.terminated(other);

    expect({ step: app.flow.state(other).stepName, ending: ending(launch), quits: app.quits() }).toEqual({ step: 'integration-slice', ending: null, quits: 0 });
  });
});

describe('the launch value (#180)', () => {
  it('refuses a launch value that does not decode, and quits nothing', () => {
    let quits = 0;
    expect({ setup: setupBenchLaunch('{ "schema_version": 1, ', '/launched', () => void quits++), quits }).toEqual({
      setup: { ok: false, error: 'launch-undecodable' },
      quits: 0,
    });
  });

  it('refuses a launch value whose working folder is not the folder the app opened', async () => {
    const launch = await prepared();

    expect(setupBenchLaunch(encodeBenchLaunch(launch), b.outsideDir('bench-span-elsewhere'), () => undefined)).toEqual({ ok: false, error: 'launch-folder-mismatch' });
  });

  it('honours a launch value naming the folder the app opened, and gives no ports without one', async () => {
    const launch = await prepared();

    const setups = [setupBenchLaunch(encodeBenchLaunch(launch), launch.workingFolder, () => undefined), setupBenchLaunch(undefined, launch.workingFolder, () => undefined)];

    expect(setups.map((s) => (s.ok ? (s.ports === null ? 'no ports' : 'ports') : s.error))).toEqual(['ports', 'no ports']);
  });
});
