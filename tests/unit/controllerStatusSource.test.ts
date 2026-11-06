import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createControllerStatus } from '../../src/main/controllerStatus';
import { createLoopMessages } from '../../src/main/loopMessages';
import type { ControllerLoopMessage, ControllerWorkStatus } from '../../src/shared/ipc';

let consoleError: { mock: { calls: unknown[][] }; mockRestore(): void };
beforeEach(() => { consoleError = vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { consoleError.mockRestore(); });
const recorded = (): string[] => consoleError.mock.calls.map((call: unknown[]) => call.map(String).join(' '));

it.each([0, Infinity, Number.MAX_SAFE_INTEGER + 1])('keeps known work visible when persisted ticket %s is invalid', number => {
  const source = createControllerStatus({
    current: () => ({ repoKey: '/repo', flowName: 'delivery', activity: 'active', loopMessage: null, view: {
      stepName: 'work', status: 'in_progress', runStarted: 'started', refs: { ticket: number },
    } }),
    refTitle: async () => null,
    branch: async () => null,
  });
  let shown: ControllerWorkStatus | undefined;
  source.subscribe(work => { shown = work; });
  try {
    source.refresh();
    expect(shown).toMatchObject({ flow: { availability: 'known', name: 'delivery', assignment: 'assigned' }, activity: 'active', ticket: { availability: 'unavailable' } });
  } finally { source.dispose(); }
});

it.each(['Issue title', ''])('accepts only the required flow facts and a title string (%j)', async title => {
  const source = createControllerStatus({
    current: () => ({ repoKey: '/repo', flowName: 'delivery', activity: 'active', loopMessage: null, view: {
      stepName: 'work', status: 'in_progress', runStarted: 'started', refs: { ticket: 219 },
      loop: { status: 'awaiting-approval', humanNeeded: true, verdictReason: 'Review required' },
    } }),
    refTitle: async () => title,
    branch: async () => null,
  });
  let shown: ControllerWorkStatus | undefined;
  source.subscribe(work => { shown = work; });
  try {
    source.refresh();
    await expect.poll(() => shown?.ticket).toEqual({ availability: 'known', number: 219, title: { availability: 'known', text: title } });
    expect(shown?.attention).toEqual({ status: 'awaiting-approval', reasons: ['Review required'] });
  } finally { source.dispose(); }
});

it('keeps publishing the work when a title or branch read throws before returning', async () => {
  const source = createControllerStatus({
    current: () => ({ repoKey: '/repo', flowName: 'delivery', activity: 'active', loopMessage: null, view: {
      stepName: 'work', status: 'in_progress', runStarted: 'started', refs: { ticket: 219 },
    } }),
    refTitle: () => { throw new Error('title read failed'); },
    branch: () => { throw new Error('branch read failed'); },
  });
  let shown: ControllerWorkStatus | undefined;
  source.subscribe(work => { shown = work; });
  try {
    source.refresh();
    await expect.poll(() => shown?.ticket).toEqual({ availability: 'known', number: 219, title: { availability: 'unavailable' } });
    expect(shown).toMatchObject({ flow: { availability: 'known', name: 'delivery' }, error: null, title: '#219', branch: null });
    expect(recorded()).toEqual(expect.arrayContaining([expect.stringContaining('title read failed'), expect.stringContaining('branch read failed')]));
  } finally { source.dispose(); }
});

it('keeps delivering the work to every subscriber when one subscriber throws', async () => {
  let resolveTitle: (title: string | null) => void = () => {};
  const source = createControllerStatus({
    current: () => ({ repoKey: '/repo', flowName: 'delivery', activity: 'active', loopMessage: null, view: {
      stepName: 'work', status: 'in_progress', runStarted: 'started', refs: { ticket: 219 },
    } }),
    refTitle: () => new Promise(resolve => { resolveTitle = resolve; }),
    branch: async () => null,
  });
  source.subscribe(work => { if (work.title === 'Fix the login redirect') throw new Error('subscriber broke'); });
  let shown: ControllerWorkStatus | undefined;
  source.subscribe(work => { shown = work; });
  try {
    source.refresh();
    resolveTitle('Fix the login redirect');
    await expect.poll(() => shown?.title).toBe('Fix the login redirect');
    expect(shown?.error).toBeNull();
    expect(recorded()).toEqual(expect.arrayContaining([expect.stringContaining('subscriber broke')]));
  } finally { source.dispose(); }
});

it('gives each status subscriber its own snapshot, including late subscribers', () => {
  const source = createControllerStatus({
    current: () => ({ repoKey: '/repo', flowName: 'delivery', activity: 'active', loopMessage: null, view: {
      stepName: 'work', status: 'in_progress', runStarted: 'started',
      loop: { status: 'awaiting-approval', humanNeeded: true, verdictReason: 'Review required' },
    } }),
    refTitle: async () => null,
    branch: async () => null,
  });
  source.subscribe(work => { work.attention?.reasons.push('Subscriber edit'); });
  let observed: ControllerWorkStatus | undefined;
  source.subscribe(work => { observed = work; });
  try {
    source.refresh();
    expect(observed?.attention?.reasons).toEqual(['Review required']);
    observed!.attention!.reasons.push('Another edit');
    source.subscribe(work => { expect(work.attention?.reasons).toEqual(['Review required']); });
  } finally { source.dispose(); }
});

it('publishes the latest loop message beside the flow\'s own error, and none when there is none', () => {
  let loopMessage: ControllerLoopMessage | null = { id: 'm1', kind: 'notice', reason: 'nothing to commit' };
  const source = createControllerStatus({
    current: () => ({ repoKey: '/repo', flowName: 'delivery', activity: 'quiet', loopMessage, view: {
      stepName: 'work', status: 'in_progress', runStarted: 'started', error: 'step failed',
    } }),
    refTitle: async () => null,
    branch: async () => null,
  });
  let shown: ControllerWorkStatus | undefined;
  source.subscribe(work => { shown = work; });
  try {
    source.refresh();
    expect([shown?.error, shown?.loopMessage]).toEqual([{ reason: 'step failed' }, { id: 'm1', kind: 'notice', reason: 'nothing to commit' }]);
    loopMessage = null;
    source.refresh();
    expect(shown?.loopMessage).toBeNull();
  } finally { source.dispose(); }
});

function stepSource(initial: { step: string; loop: string; message: ControllerLoopMessage | null; errorReason?: string }) {
  const now = { ...initial };
  const source = createControllerStatus({
    current: () => {
      const errorReason = now.loop === 'error' ? now.errorReason ?? now.message?.reason : undefined;
      return { repoKey: '/repo', flowName: 'delivery', activity: 'active', loopMessage: now.message, view: {
        stepName: now.step, status: 'in_progress', runStarted: 'started', loop: { status: now.loop, ...(errorReason ? { errorReason } : {}) },
      } };
    },
    refTitle: async () => null,
    branch: async () => null,
  });
  let shown: ControllerWorkStatus | undefined;
  source.subscribe(work => { shown = work; });
  source.refresh();
  return { now, source, shown: () => shown };
}

const stalled: ControllerLoopMessage = { id: 'e1', kind: 'error', reason: 'stalled: no terminal activity' };

it('withdraws a shown loop error once the loop leaves its error status, as the terminal does', () => {
  const { now, source, shown } = stepSource({ step: 'groom-intent', loop: 'error', message: stalled });
  try {
    expect(shown()?.loopMessage).toEqual(stalled);
    now.loop = 'working';
    source.refresh();
    expect(shown()?.loopMessage ?? null).toBeNull();
  } finally { source.dispose(); }
});

it('withdraws a shown loop error when the flow moves to a new step, and shows the next error raised there', () => {
  const { now, source, shown } = stepSource({ step: 'groom-intent', loop: 'error', message: stalled });
  try {
    expect(shown()?.loopMessage).toEqual(stalled);
    now.step = 'groom';
    source.refresh();
    expect(shown()?.loopMessage ?? null).toBeNull();
    now.loop = 'working';
    source.refresh();
    expect(shown()?.loopMessage ?? null).toBeNull();
    now.message = { id: 'e2', kind: 'error', reason: 'the review turn failed' };
    source.refresh();
    expect(shown()?.loopMessage).toEqual(now.message);
  } finally { source.dispose(); }
});

it('shows a loop error first raised as the flow enters a new step', () => {
  const { now, source, shown } = stepSource({ step: 'groom-intent', loop: 'error', message: stalled });
  try {
    now.step = 'groom';
    now.loop = 'error';
    now.message = { id: 'e2', kind: 'error', reason: 'the groom turn failed' };
    source.refresh();
    expect(shown()?.loopMessage).toEqual(now.message);
  } finally { source.dispose(); }
});

it('keeps a loop error while the flow stays on its step and the loop stays in error', () => {
  const { source, shown } = stepSource({ step: 'impl-approve', loop: 'error', message: stalled });
  try {
    source.refresh();
    expect(shown()?.loopMessage).toEqual(stalled);
  } finally { source.dispose(); }
});

it('keeps an error raised while the loop was not in error, such as a failed push at an approve, after the step advances', () => {
  const pushFailed: ControllerLoopMessage = { id: 'p1', kind: 'error', reason: 'could not push fix/x to the pull request' };
  const { now, source, shown } = stepSource({ step: 'impl-approve', loop: 'awaiting-approval', message: pushFailed });
  try {
    now.step = 'finalize';
    now.loop = 'working';
    source.refresh();
    expect(shown()?.loopMessage).toEqual(pushFailed);
  } finally { source.dispose(); }
});

it('keeps a notice when the step advances and the loop leaves its error status', () => {
  const notice: ControllerLoopMessage = { id: 'n1', kind: 'notice', reason: 'nothing to commit' };
  const { now, source, shown } = stepSource({ step: 'green', loop: 'error', message: notice });
  try {
    now.step = 'green-approve';
    now.loop = 'working';
    source.refresh();
    expect(shown()?.loopMessage).toEqual(notice);
  } finally { source.dispose(); }
});

it('keeps a withdrawn loop error withdrawn on later refreshes', () => {
  const { now, source, shown } = stepSource({ step: 'groom-intent', loop: 'error', message: stalled });
  try {
    now.loop = 'working';
    source.refresh();
    source.refresh();
    now.step = 'groom';
    source.refresh();
    expect(shown()?.loopMessage ?? null).toBeNull();
  } finally { source.dispose(); }
});

it('keeps an error raised while the loop is in error that is not the loop\'s own error, such as a missing input announced on Retry', () => {
  const missingInput: ControllerLoopMessage = { id: 'w1', kind: 'error', reason: 'groom: recorded input(s) no longer available — groom-intent' };
  const { now, source, shown } = stepSource({ step: 'groom', loop: 'error', errorReason: stalled.reason, message: missingInput });
  try {
    now.loop = 'working';
    source.refresh();
    expect(shown()?.loopMessage).toEqual(missingInput);
  } finally { source.dispose(); }
});

it('withdraws the loop\'s own error when its reason was too long to publish whole', () => {
  const reason = `stalled: ${'x'.repeat(20 * 1024)}`;
  const messages = createLoopMessages(() => {});
  messages.post('error', reason);
  const { now, source, shown } = stepSource({ step: 'groom-intent', loop: 'error', errorReason: reason, message: messages.current() });
  try {
    expect(shown()?.loopMessage?.kind).toBe('error');
    now.loop = 'working';
    source.refresh();
    expect(shown()?.loopMessage ?? null).toBeNull();
  } finally { source.dispose(); }
});

type Refs = { ticket?: number; pr?: number };
interface TitleRequest { repoKey: string; kind: 'issue' | 'pr'; number: number; resolve(title: string | null): void }
interface BranchRequest { repoKey: string; resolve(branch: string | null): void; reject(error: unknown): void }

const sources: Array<{ dispose(): void }> = [];
afterEach(() => { for (const source of sources.splice(0)) source.dispose(); });
const flushPromises = () => new Promise<void>(resolve => setImmediate(resolve));

function identitySource(initial: { repoKey?: string; refs?: Refs; userTitle?: string } = {}) {
  const now = { repoKey: '/repo', refs: {} as Refs, userTitle: undefined as string | undefined, ...initial };
  const titleRequests: TitleRequest[] = [];
  const branchRequests: BranchRequest[] = [];
  const source = createControllerStatus({
    current: () => ({ repoKey: now.repoKey, flowName: 'delivery', activity: 'active', loopMessage: null, view: {
      stepName: 'work', status: 'in_progress', runStarted: 'started', refs: { ...now.refs },
      ...(now.userTitle !== undefined ? { userTitle: now.userTitle } : {}),
    } }),
    refTitle: (repoKey, kind, number) => new Promise(resolve => { titleRequests.push({ repoKey, kind, number, resolve }); }),
    branch: repoKey => new Promise((resolve, reject) => { branchRequests.push({ repoKey, resolve, reject }); }),
  });
  sources.push(source);
  const seen: ControllerWorkStatus[] = [];
  let shown: ControllerWorkStatus | undefined;
  source.subscribe(work => { shown = work; seen.push(work); });
  source.refresh();
  const titleRequest = (kind: 'issue' | 'pr', number: number) => titleRequests.find(request => request.kind === kind && request.number === number);
  return { now, source, shown: () => shown, seen, titleRequests, titleRequest, branchRequests };
}

describe('the title a terminal reports', () => {
  it('is the user title when no ticket or pull request is set', () => {
    const { shown } = identitySource({ userTitle: 'Refactor the shadow parser' });
    expect(shown()?.title).toBe('Refactor the shadow parser');
  });

  it.each([{ userTitle: '' }, {}])('is null when the user has not named the work: %j', initial => {
    const { shown } = identitySource(initial);
    expect(shown()?.title).toBeNull();
  });

  it('is #N for a ticket until its GitHub title resolves, then that title with control characters stripped, from one fetch', async () => {
    const { shown, source, titleRequests, titleRequest } = identitySource({ refs: { ticket: 219 }, userTitle: 'My own name' });
    expect(shown()?.title).toBe('#219');
    expect(titleRequests.map(({ repoKey, kind, number }) => ({ repoKey, kind, number }))).toEqual([{ repoKey: '/repo', kind: 'issue', number: 219 }]);
    titleRequest('issue', 219)?.resolve('Fix the\u0007login redirect');
    await expect.poll(() => shown()?.title).toBe('Fix the login redirect');
    expect(shown()?.ticket).toMatchObject({ number: 219, title: { availability: 'known' } });
    source.refresh();
    await flushPromises();
    expect(titleRequests).toHaveLength(1);
  });

  it('is PR #N for a pull request over the ticket and user title, then the pull request\'s own GitHub title', async () => {
    const { shown, titleRequest } = identitySource({ refs: { ticket: 219, pr: 301 }, userTitle: 'My own name' });
    expect(shown()?.title).toBe('PR #301');
    titleRequest('issue', 219)?.resolve('The ticket title');
    await flushPromises();
    expect(shown()?.title).toBe('PR #301');
    titleRequest('pr', 301)?.resolve('The pull request title');
    await expect.poll(() => shown()?.title).toBe('The pull request title');
    expect(shown()?.ticket).toMatchObject({ number: 219, title: { availability: 'known', text: 'The ticket title' } });
  });

  it('keeps #N when the GitHub title is unavailable', async () => {
    const { shown, titleRequest } = identitySource({ refs: { ticket: 219 } });
    titleRequest('issue', 219)?.resolve(null);
    await flushPromises();
    expect(shown()?.title).toBe('#219');
  });

  it('returns to the user title once the ref is cleared', async () => {
    const { now, shown, source, titleRequest } = identitySource({ refs: { ticket: 219 }, userTitle: 'My own name' });
    titleRequest('issue', 219)?.resolve('GitHub says so');
    await expect.poll(() => shown()?.title).toBe('GitHub says so');
    now.refs = {};
    source.refresh();
    expect(shown()?.title).toBe('My own name');
  });

  it.each([
    ['ticket', (now: { repoKey: string; refs: Refs }) => { now.refs = { ticket: 220 }; }, '#220'],
    ['repository', (now: { repoKey: string; refs: Refs }) => { now.repoKey = '/other'; }, '#219'],
    ['pull request', (now: { repoKey: string; refs: Refs }) => { now.refs = { pr: 302 }; }, 'PR #302', { pr: 301 }],
  ])('is not relabelled by a late result for a replaced %s', async (_, replace, expected, refs: Refs = { ticket: 219 }) => {
    const { now, shown, seen, source, titleRequests } = identitySource({ refs });
    replace(now);
    source.refresh();
    expect(shown()?.title).toBe(expected);
    expect(titleRequests).toHaveLength(2);
    titleRequests[0].resolve('OBSOLETE_TITLE');
    await flushPromises();
    titleRequests[1].resolve('CURRENT_TITLE');
    await expect.poll(() => shown()?.title).toBe('CURRENT_TITLE');
    expect(seen.map(work => work.title)).not.toContain('OBSOLETE_TITLE');
  });
});

describe('the branch a terminal reports', () => {
  // §23.6 "Live work and attention": publication follows the work within two seconds.
  const BRANCH_FOLLOW_BUDGET_MS = 2_000;
  const timePasses = () => { vi.advanceTimersByTime(BRANCH_FOLLOW_BUDGET_MS); };
  beforeEach(() => { vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] }); });
  afterEach(() => { vi.useRealTimers(); });

  it('is what the branch read returns for the current repository', async () => {
    const { shown, branchRequests } = identitySource();
    await expect.poll(() => branchRequests.map(request => request.repoKey)).toEqual(['/repo']);
    branchRequests[0].resolve('feature/card-identity');
    await expect.poll(() => shown()?.branch).toBe('feature/card-identity');
  });

  it('is null when the read finds no branch', async () => {
    const { shown, branchRequests } = identitySource();
    await expect.poll(() => branchRequests.length).toBe(1);
    branchRequests[0].resolve('first-branch');
    await expect.poll(() => shown()?.branch).toBe('first-branch');
    timePasses();
    await expect.poll(() => branchRequests.length).toBe(2);
    branchRequests[1].resolve(null);
    await expect.poll(() => shown()?.branch).toBeNull();
  });

  it('is read again as time passes, once the previous read has completed', async () => {
    const { shown, branchRequests } = identitySource();
    await expect.poll(() => branchRequests.length).toBe(1);
    branchRequests[0].resolve('first-branch');
    await expect.poll(() => shown()?.branch).toBe('first-branch');
    timePasses();
    await expect.poll(() => branchRequests.length).toBe(2);
    branchRequests[1].resolve('second-branch');
    await expect.poll(() => shown()?.branch).toBe('second-branch');
  });

  it('does not start another read for the same repository while one is pending', async () => {
    const { branchRequests } = identitySource();
    await expect.poll(() => branchRequests.length).toBe(1);
    timePasses();
    timePasses();
    timePasses();
    await flushPromises();
    expect(branchRequests.map(request => request.repoKey)).toEqual(['/repo']);
  });

  it('is not read again by a status refresh for the same repository', async () => {
    const { source, branchRequests } = identitySource();
    await expect.poll(() => branchRequests.length).toBe(1);
    branchRequests[0].resolve('first-branch');
    await flushPromises();
    source.refresh();
    source.refresh();
    await flushPromises();
    expect(branchRequests.map(request => request.repoKey)).toEqual(['/repo']);
  });

  it('starts a read for a new repository at once, without waiting for a slow read of the old one', async () => {
    const { now, shown, source, branchRequests } = identitySource({ repoKey: '/old' });
    await expect.poll(() => branchRequests.length).toBe(1);
    now.repoKey = '/new';
    source.refresh();
    await expect.poll(() => branchRequests.map(request => request.repoKey)).toEqual(['/old', '/new']);
    branchRequests[1].resolve('new-branch');
    await expect.poll(() => shown()?.branch).toBe('new-branch');
  });

  it('never publishes a result for a repository that is no longer current', async () => {
    const { now, shown, seen, source, branchRequests } = identitySource({ repoKey: '/old' });
    await expect.poll(() => branchRequests.length).toBe(1);
    now.repoKey = '/new';
    source.refresh();
    await expect.poll(() => branchRequests.length).toBe(2);
    branchRequests[1].resolve('new-branch');
    await expect.poll(() => shown()?.branch).toBe('new-branch');
    branchRequests[0].resolve('old-branch');
    await flushPromises();
    expect(shown()?.branch).toBe('new-branch');
    expect(seen.map(work => work.branch)).not.toContain('old-branch');
  });

  it('is null when the read fails, and the rest of the status still publishes', async () => {
    const { now, shown, source, branchRequests } = identitySource({ userTitle: 'First name' });
    await expect.poll(() => branchRequests.length).toBe(1);
    branchRequests[0].resolve('first-branch');
    await expect.poll(() => shown()?.branch).toBe('first-branch');
    timePasses();
    await expect.poll(() => branchRequests.length).toBe(2);
    branchRequests[1].reject(new Error('git exploded'));
    await expect.poll(() => shown()?.branch).toBeNull();
    now.userTitle = 'Second name';
    source.refresh();
    expect(shown()?.title).toBe('Second name');
  });

  it('records why the read failed once while it keeps failing the same way, and again after it recovers', async () => {
    const { shown, branchRequests } = identitySource();
    const failures = () => recorded().filter(line => line.includes('git could not run')).length;
    await expect.poll(() => branchRequests.length).toBe(1);
    branchRequests[0].reject(new Error('git could not run'));
    await expect.poll(failures).toBe(1);
    timePasses();
    await expect.poll(() => branchRequests.length).toBe(2);
    branchRequests[1].reject(new Error('git could not run'));
    await flushPromises();
    expect(failures()).toBe(1);
    timePasses();
    await expect.poll(() => branchRequests.length).toBe(3);
    branchRequests[2].resolve('recovered');
    await expect.poll(() => shown()?.branch).toBe('recovered');
    timePasses();
    await expect.poll(() => branchRequests.length).toBe(4);
    branchRequests[3].reject(new Error('git could not run'));
    await expect.poll(failures).toBe(2);
  });

  it('records a failure again for a new repository even when the reason is the same', async () => {
    const { now, source, branchRequests } = identitySource({ repoKey: '/old' });
    const failures = () => recorded().filter(line => line.includes('git could not run')).length;
    await expect.poll(() => branchRequests.length).toBe(1);
    branchRequests[0].reject(new Error('git could not run'));
    await expect.poll(failures).toBe(1);
    now.repoKey = '/new';
    source.refresh();
    await expect.poll(() => branchRequests.map(request => request.repoKey)).toEqual(['/old', '/new']);
    branchRequests[1].reject(new Error('git could not run'));
    await expect.poll(failures).toBe(2);
  });

  it('is not read again once the status source is disposed', async () => {
    const { source, branchRequests } = identitySource();
    await expect.poll(() => branchRequests.length).toBe(1);
    branchRequests[0].resolve('first-branch');
    await flushPromises();
    timePasses();
    await expect.poll(() => branchRequests.length).toBe(2);
    branchRequests[1].resolve('first-branch');
    await flushPromises();
    source.dispose();
    timePasses();
    timePasses();
    await flushPromises();
    expect(branchRequests).toHaveLength(2);
  });
});
