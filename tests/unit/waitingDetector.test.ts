import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWaitingDetector, type ControllerActivity, type WaitingDetector } from '../../src/main/waitingDetector';
import { resolveRuntimeConfig } from '../../src/main/runtimeConfig';
import type { WaitingValue } from '../../src/shared/waiting';

const RULE_REPORTS_AFTER_MARK_MS = 1000;
const AC_BOUND_MS = 5000;
const STEP_MS = 50;

const NODE: WaitingValue = { program: 'node', others: 0 };
const WAITING_NODE: ControllerActivity = { activity: 'waiting', waiting: NODE };

type Answer = WaitingValue | null | 'hang' | 'fail' | 'throw';

function harness(answer: (now: number, call: number) => Answer) {
  const lookups: number[] = [];
  const published: Array<{ at: number; activity: ControllerActivity }> = [];
  const detector: WaitingDetector = createWaitingDetector({
    commands(signal) {
      const call = lookups.push(Date.now()) - 1;
      const reply = answer(Date.now(), call);
      if (reply === 'throw') throw new Error('ps not started');
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

  it('leaves Waiting within 5 s of the last command exiting just after the screen went quiet', async () => {
    const flipped = 10_000;
    const exited = flipped + 500;
    const { detector, published } = harness((now) => (now < exited ? NODE : null));
    detector.screen('active');
    await runTo(flipped);
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

describe('the controller activity\'s lookups and failures', () => {
  const timers = { setTimer: (cb: () => void, ms: number) => setTimeout(cb, ms), clearTimer: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>) };
  const lookupTimeoutMs = resolveRuntimeConfig({}).waitingLookupTimeoutMs;

  function hangingDetector(onChange: (activity: ControllerActivity) => void = () => {}) {
    const signals: AbortSignal[] = [];
    const detector = createWaitingDetector({
      commands(signal) {
        signals.push(signal);
        return new Promise(() => {});
      },
      timers, lookupTimeoutMs, onChange,
    });
    return { detector, signals };
  }

  it('abandons a lookup that misses its bound, and one still running when the screen turns active or the detector is disposed', async () => {
    const timedOut = hangingDetector();
    timedOut.detector.screen('quiet');
    await runTo(lookupTimeoutMs * 3);
    const flipped = hangingDetector();
    flipped.detector.screen('quiet');
    flipped.detector.screen('active');
    const disposed = hangingDetector();
    disposed.detector.screen('quiet');
    disposed.detector.dispose();
    const allAborted = (signals: AbortSignal[]) => signals.length > 0 && signals.every((s) => s.aborted);
    const settledLookups = timedOut.signals.slice(0, -1);
    expect({ timedOut: allAborted(settledLookups), flipped: allAborted(flipped.signals), disposed: allAborted(disposed.signals) })
      .toEqual({ timedOut: true, flipped: true, disposed: true });
    timedOut.detector.dispose();
    flipped.detector.dispose();
  });

  it('reads Idle and runs no lookup once disposed, even while Waiting', async () => {
    const { detector, lookups } = harness(() => NODE);
    detector.screen('quiet');
    await runTo(AC_BOUND_MS);
    const before = detector.current();
    detector.dispose();
    const disposedAt = Date.now();
    await runTo(disposedAt + 20_000);
    expect({ before, after: detector.current(), lookupsAfter: lookups.filter((at) => at > disposedAt).length })
      .toEqual({ before: WAITING_NODE, after: { activity: 'quiet' }, lookupsAfter: 0 });
  });

  it('logs a repeated lookup failure once, and again only after a lookup succeeds', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { detector } = harness((_, call) => (call === 3 ? null : 'fail'));
      detector.screen('quiet');
      await runTo(20_000);
      detector.dispose();
      expect(errors.mock.calls.map(([message]) => String(message))).toEqual([
        expect.stringContaining('ps exited 1'), expect.stringContaining('ps exited 1'),
      ]);
    } finally {
      errors.mockRestore();
    }
  });

  it('reads a lookup that throws before it answers as no commands, logs why, and keeps looking', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { detector, published } = harness((_, call) => (call === 0 ? 'throw' : NODE));
      detector.screen('quiet');
      await runTo(10_000);
      detector.dispose();
      expect({
        shown: published.map((entry) => entry.activity),
        logged: errors.mock.calls.map(([message]) => String(message)),
      }).toEqual({ shown: [WAITING_NODE], logged: [expect.stringContaining('ps not started')] });
    } finally {
      errors.mockRestore();
    }
  });

  it('keeps what it shows when a reader or a listener edits the activity it was given', async () => {
    const { detector, published } = harness(() => ({ program: 'node', others: 0 }));
    detector.screen('quiet');
    await runTo(10_000);
    const edit = (activity: ControllerActivity): void => {
      try {
        (activity.waiting as { program: string } | undefined)!.program = 'edited';
      } catch {
        return;
      }
    };
    edit(detector.current());
    edit(published[published.length - 1].activity);
    expect({ now: detector.current(), delivered: published.map((entry) => entry.activity) }).toEqual({ now: WAITING_NODE, delivered: [WAITING_NODE] });
    detector.dispose();
  });

  it('keeps looking, and shows what it finds, after a listener throws', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const PYTEST: WaitingValue = { program: 'pytest', others: 0 };
      let answer: WaitingValue | null = null;
      let thrown = false;
      const detector = createWaitingDetector({
        commands: () => Promise.resolve(answer),
        timers, lookupTimeoutMs,
        onChange: (activity) => {
          if (activity.activity === 'waiting' && !thrown) {
            thrown = true;
            throw new Error('listener broke');
          }
        },
      });
      detector.screen('active');
      detector.screen('quiet');
      await runTo(AC_BOUND_MS);
      answer = NODE;
      await runTo(AC_BOUND_MS * 2);
      answer = PYTEST;
      await runTo(AC_BOUND_MS * 3);
      expect({ thrown, now: detector.current() }).toEqual({ thrown: true, now: { activity: 'waiting', waiting: PYTEST } });
      detector.dispose();
    } finally {
      errors.mockRestore();
    }
  });
});

describe('what the controller activity shows while quiet', () => {
  it.each([
    ['program and count', { program: 'node', others: 1 }, { program: 'pytest', others: 0 }],
    ['count only', { program: 'node', others: 1 }, { program: 'node', others: 0 }],
    ['program only', { program: 'node', others: 0 }, { program: 'pytest', others: 0 }],
  ] as const)('follows a change of %s while it stays Waiting', async (_, before, afterChange) => {
    const changed = 20_000;
    const { detector, published } = harness((now) => (now < changed ? before : afterChange));
    detector.screen('quiet');
    await runTo(changed + AC_BOUND_MS);
    expect({ first: published.some(({ activity }) => activity.activity === 'waiting' && activity.waiting.program === before.program && activity.waiting.others === before.others), now: detector.current() })
      .toEqual({ first: true, now: { activity: 'waiting', waiting: afterChange } });
    detector.dispose();
  });

  it('shows a terminal that starts quiet with no command as Idle from the start, never Working', async () => {
    const { detector, published } = harness(() => null);
    detector.screen('quiet');
    await runTo(AC_BOUND_MS);
    expect({ working: published.some(({ activity }) => activity.activity === 'active'), now: detector.current() })
      .toEqual({ working: false, now: { activity: 'quiet' } });
    detector.dispose();
  });
});

describe('the lifecycle of a delayed Waiting lookup', () => {
  const POLL_GAP_MS = 1000;
  const PYTEST: WaitingValue = { program: 'pytest', others: 1 };

  function delayed(lookupTimeoutMs = 5000) {
    const requests: Array<{ at: number; resolve: (value: WaitingValue | null) => void }> = [];
    const published: ControllerActivity[] = [];
    const detector = createWaitingDetector({
      commands: () => new Promise((resolve) => { requests.push({ at: Date.now(), resolve }); }),
      timers: { setTimer: (cb, ms) => setTimeout(cb, ms), clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>) },
      lookupTimeoutMs,
      onChange: (activity) => published.push(activity),
    });
    return { detector, requests, published };
  }

  it('keeps a newer result when an abandoned lookup answers after its timeout', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { detector, requests, published } = delayed(200);
    try {
      detector.screen('quiet');
      await vi.advanceTimersByTimeAsync(200 + POLL_GAP_MS);
      requests[1].resolve(PYTEST);
      await vi.advanceTimersByTimeAsync(0);
      requests[0].resolve(NODE);
      await vi.advanceTimersByTimeAsync(0);
      expect({ current: detector.current(), published }).toEqual({
        current: { activity: 'waiting', waiting: PYTEST },
        published: [{ activity: 'waiting', waiting: PYTEST }],
      });
    } finally {
      detector.dispose();
      errors.mockRestore();
    }
  });

  it('a pending answer after disposal neither publishes nor starts another lookup', async () => {
    const { detector, requests, published } = delayed();
    detector.screen('quiet');
    detector.dispose();
    requests[0].resolve(NODE);
    await vi.advanceTimersByTimeAsync(20_000);
    expect({ current: detector.current(), published, started: requests.map((request) => request.at) })
      .toEqual({ current: { activity: 'quiet' }, published: [], started: [0] });
  });

  it('keeps the restarted poller current when the previous quiet period answers late', async () => {
    const { detector, requests, published } = delayed();
    try {
      detector.screen('quiet');
      detector.screen('active');
      detector.screen('quiet');
      requests[1].resolve(PYTEST);
      await vi.advanceTimersByTimeAsync(0);
      requests[0].resolve(NODE);
      await vi.advanceTimersByTimeAsync(POLL_GAP_MS);
      expect({ current: detector.current(), published, started: requests.map((request) => request.at) }).toEqual({
        current: { activity: 'waiting', waiting: PYTEST },
        published: [{ activity: 'active' }, { activity: 'waiting', waiting: PYTEST }],
        started: [0, 0, POLL_GAP_MS],
      });
    } finally {
      detector.dispose();
    }
  });

  it('waits for a slow lookup to settle before starting the polling gap', async () => {
    const { detector, requests } = delayed();
    try {
      detector.screen('quiet');
      await vi.advanceTimersByTimeAsync(1500);
      expect(requests.map((request) => request.at)).toEqual([0]);
      requests[0].resolve(NODE);
      await vi.advanceTimersByTimeAsync(POLL_GAP_MS - 1);
      expect(requests.map((request) => request.at)).toEqual([0]);
      await vi.advanceTimersByTimeAsync(1);
      expect({ current: detector.current(), started: requests.map((request) => request.at) })
        .toEqual({ current: WAITING_NODE, started: [0, 2500] });
    } finally {
      detector.dispose();
    }
  });
});

describe('the outer activity snapshot', () => {
  it.each(['activity', 'waiting'] as const)('isolates edits to %s through readers and listeners in every activity', async (field) => {
    const { detector, published } = harness(() => NODE);
    const edit = (value: ControllerActivity): void => {
      Reflect.set(value, field, field === 'activity' ? 'edited' : { program: 'edited', others: 99 });
    };
    try {
      edit(detector.current());
      expect(detector.current()).toEqual({ activity: 'quiet' });
      detector.screen('active');
      edit(detector.current());
      expect({ current: detector.current(), delivered: published[0].activity })
        .toEqual({ current: { activity: 'active' }, delivered: { activity: 'active' } });
      edit(published[0].activity);
      expect(detector.current()).toEqual({ activity: 'active' });
      detector.screen('quiet');
      await runTo(AC_BOUND_MS);
      edit(detector.current());
      expect({ current: detector.current(), delivered: published[published.length - 1].activity })
        .toEqual({ current: WAITING_NODE, delivered: WAITING_NODE });
      edit(published[published.length - 1].activity);
      expect(detector.current()).toEqual(WAITING_NODE);
      detector.dispose();
      edit(detector.current());
      expect(detector.current()).toEqual({ activity: 'quiet' });
    } finally {
      detector.dispose();
    }
  });
});
