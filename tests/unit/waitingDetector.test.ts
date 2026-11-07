import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWaitingDetector, type ControllerActivity, type WaitingDetector } from '../../src/main/waitingDetector';
import { resolveRuntimeConfig } from '../../src/main/runtimeConfig';
import type { WaitingValue } from '../../src/shared/waiting';

// How long after a command's 1 s mark the rule first reports it: the rule counts a command from an elapsed reading
// that macOS can round up from just over a second.
const RULE_REPORTS_AFTER_MARK_MS = 1000;
const AC_BOUND_MS = 5000;
const STEP_MS = 50;

const NODE: WaitingValue = { program: 'node', others: 0 };
const WAITING_NODE: ControllerActivity = { activity: 'waiting', waiting: NODE };

type Answer = WaitingValue | null | 'hang' | 'fail';

/** The agent's commands as the lookup reports them over time, with every lookup's start time recorded. */
function harness(answer: (now: number, call: number) => Answer) {
  const lookups: number[] = [];
  const published: Array<{ at: number; activity: ControllerActivity }> = [];
  const detector: WaitingDetector = createWaitingDetector({
    commands(signal) {
      const call = lookups.push(Date.now()) - 1;
      const reply = answer(Date.now(), call);
      if (reply === 'fail') return Promise.reject(new Error('ps exited 1'));
      if (reply === 'hang') return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
      return Promise.resolve(reply);
    },
    timers: { setTimer: (cb, ms) => setTimeout(cb, ms), clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>) },
    lookupTimeoutMs: resolveRuntimeConfig({}).waitingLookupTimeoutMs,
    onChange: (activity) => published.push({ at: Date.now(), activity }),
  });
  return { detector, lookups, published };
}

async function runTo(at: number): Promise<void> {
  while (Date.now() < at) await vi.advanceTimersByTimeAsync(Math.min(STEP_MS, at - Date.now()));
}

beforeEach(() => {
  vi.useFakeTimers({ now: 0 });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('the controller activity while the screen is quiet', () => {
  it.each([
    ['every lookup answers', false],
    ['the first lookup that could see the command never answers', true],
  ])('reads Waiting within 5 s of a command\'s 1 s mark when %s', async (_, hangOnce) => {
    const started = 10_000;
    const reportable = started + 1000 + RULE_REPORTS_AFTER_MARK_MS;
    let hung = false;
    const { detector } = harness((now) => {
      if (now < reportable) return null;
      if (hangOnce && !hung) {
        hung = true;
        return 'hang';
      }
      return NODE;
    });
    detector.screen('active');
    await runTo(1000);
    detector.screen('quiet');
    await runTo(started + 1000 + AC_BOUND_MS);
    expect(detector.current()).toEqual(WAITING_NODE);
    detector.dispose();
  });

  it.each([
    ['every lookup answers', 'answer'],
    ['no later lookup ever answers', 'hang'],
    ['every later lookup fails', 'fail'],
  ] as const)('leaves Waiting within 5 s of the last command exiting when %s', async (_, next) => {
    const exited = 20_000;
    const { detector, published } = harness((now) => {
      if (now < exited) return NODE;
      return next === 'answer' ? null : next;
    });
    detector.screen('quiet');
    await runTo(exited + AC_BOUND_MS);
    expect({ waited: published.some(({ activity }) => activity.activity === 'waiting'), now: detector.current() })
      .toEqual({ waited: true, now: { activity: 'quiet' } });
    detector.dispose();
  });

  it.each([
    ['every lookup finds none', null],
    ['every lookup fails', 'fail'],
    ['no lookup ever answers', 'hang'],
  ] as const)('reads Idle, and never Waiting, once the screen is quiet with no command running and %s', async (_, answer) => {
    const { detector, published } = harness(() => answer);
    detector.screen('active');
    await runTo(1000);
    detector.screen('quiet');
    await runTo(1000 + 20_000);
    expect({ now: detector.current(), waited: published.some(({ activity }) => activity.activity === 'waiting') })
      .toEqual({ now: { activity: 'quiet' }, waited: false });
    detector.dispose();
  });

  it('publishes no quiet activity before Waiting when a command is already running as the screen goes quiet', async () => {
    const { detector, published } = harness(() => NODE);
    detector.screen('active');
    await runTo(1000);
    detector.screen('quiet');
    await runTo(1000 + AC_BOUND_MS);
    const shown = published.map(({ activity }) => activity.activity).filter((kind, i, all) => i === 0 || all[i - 1] !== kind);
    expect(shown).toEqual(['active', 'waiting']);
    detector.dispose();
  });
});

describe('the controller activity while the screen is changing', () => {
  it('runs no lookup while the screen is active, and looks again once it is quiet', async () => {
    const { detector, lookups } = harness(() => NODE);
    detector.screen('active');
    await runTo(20_000);
    const whileActive = lookups.length;
    detector.screen('quiet');
    await runTo(20_000 + AC_BOUND_MS);
    expect({ whileActive, onceQuiet: lookups.length > 0 }).toEqual({ whileActive: 0, onceQuiet: true });
    detector.dispose();
  });

  it('reads Working at once when the screen turns active while Waiting, and neither looks again nor reads Waiting until it is quiet again', async () => {
    const { detector, published, lookups } = harness(() => NODE);
    detector.screen('quiet');
    await runTo(AC_BOUND_MS);
    const before = detector.current();
    const flip = Date.now();
    detector.screen('active');
    const atFlip = detector.current();
    await runTo(flip + 20_000);
    const waitingAfterFlip = published.filter(({ at, activity }) => at >= flip && activity.activity === 'waiting').length;
    const lookupsAfterFlip = lookups.filter((at) => at > flip).length;
    expect({ before, atFlip, waitingAfterFlip, lookupsAfterFlip })
      .toEqual({ before: WAITING_NODE, atFlip: { activity: 'active' }, waitingAfterFlip: 0, lookupsAfterFlip: 0 });
    detector.dispose();
  });

  it('ignores the answer of a lookup still running when the screen turns active', async () => {
    let release: ((value: WaitingValue) => void) | undefined;
    const lookups: number[] = [];
    const published: ControllerActivity[] = [];
    const detector = createWaitingDetector({
      commands: () => {
        lookups.push(Date.now());
        return new Promise<WaitingValue>((resolve) => { release = resolve; });
      },
      timers: { setTimer: (cb, ms) => setTimeout(cb, ms), clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>) },
      lookupTimeoutMs: resolveRuntimeConfig({}).waitingLookupTimeoutMs,
      onChange: (activity) => published.push(activity),
    });
    detector.screen('quiet');
    while (lookups.length === 0 && Date.now() < AC_BOUND_MS) await vi.advanceTimersByTimeAsync(STEP_MS);
    const inFlight = lookups.length > 0 && release !== undefined;
    const flip = Date.now();
    detector.screen('active');
    release?.(NODE);
    await runTo(flip + 20_000);
    expect({ inFlight, now: detector.current(), waiting: published.filter((a) => a.activity === 'waiting').length })
      .toEqual({ inFlight: true, now: { activity: 'active' }, waiting: 0 });
    detector.dispose();
  });
});
