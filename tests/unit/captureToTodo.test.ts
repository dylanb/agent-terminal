// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { captureToTodo } from '../../src/renderer/src/selection';
import { TODOS_CHANGED_EVENT } from '../../src/renderer/src/paneActions';
import { cleanSelectionText } from '../../src/renderer/src/selectionModel';

function makeMonitor(over: Partial<Record<string, ReturnType<typeof vi.fn>>> = {}) {
  return {
    todoAdd: vi.fn(async () => []),
    commands: vi.fn(async () => []),
    captureCommandText: vi.fn(async () => null),
    ...over,
  };
}

describe('Capture selection → todo (§16.2 — selection-or-latest-command, cross-pane refresh)', () => {
  let signalled = 0;
  const onChange = () => signalled++;

  afterEach(() => {
    vi.restoreAllMocks();
    window.removeEventListener(TODOS_CHANGED_EVENT, onChange);
    signalled = 0;
  });

  function listen() {
    window.addEventListener(TODOS_CHANGED_EVENT, onChange);
  }

  it('with a selection: adds the cleaned selected text and signals a change; never reads commands', async () => {
    listen();
    const monitor = makeMonitor();
    await captureToTodo(monitor as never, '/repo', '  pick this up  ');
    expect(monitor.todoAdd).toHaveBeenCalledWith('/repo', cleanSelectionText('  pick this up  '), {
      type: 'selection',
    });
    expect(monitor.commands).not.toHaveBeenCalled();
    expect(monitor.captureCommandText).not.toHaveBeenCalled();
    expect(signalled).toBe(1);
  });

  it('with no selection: captures the latest command output to todo and signals a change', async () => {
    listen();
    const monitor = makeMonitor({
      commands: vi.fn(async () => [
        { id: 'old', sessionId: 's1', command: 'first', exitCode: 0, running: false, startedAt: 0, truncated: false },
        { id: 'new', sessionId: 's1', command: 'latest', exitCode: 0, running: false, startedAt: 1, truncated: false },
      ]),
      captureCommandText: vi.fn(async () => ({ text: 'command output', truncated: false })),
    });
    await captureToTodo(monitor as never, '/repo', null);
    expect(monitor.captureCommandText).toHaveBeenCalledWith('new'); // newest-last
    expect(monitor.todoAdd).toHaveBeenCalledWith('/repo', 'command output', { type: 'command-output' });
    expect(signalled).toBe(1);
  });

  it('with no selection and no commands: does nothing and does not signal', async () => {
    listen();
    const monitor = makeMonitor();
    await captureToTodo(monitor as never, '/repo', null);
    expect(monitor.captureCommandText).not.toHaveBeenCalled();
    expect(monitor.todoAdd).not.toHaveBeenCalled();
    expect(signalled).toBe(0);
  });

  it('a rejected IPC invoke is swallowed (no unhandled rejection) and no change is signalled', async () => {
    // A main-process restart can reject todoAdd; the detached `void captureToTodo(...)` call sites
    // must not surface an unhandled rejection. vitest fails the run on one, so this pins the catch.
    listen();
    const monitor = makeMonitor({ todoAdd: vi.fn(async () => { throw new Error('ipc down'); }) });
    await expect(captureToTodo(monitor as never, '/repo', 'x')).resolves.toBeUndefined();
    expect(signalled).toBe(0);
  });

  it('a selection that cleans to empty is not persisted and signals nothing (empty-guard)', async () => {
    listen();
    const monitor = makeMonitor();
    await captureToTodo(monitor as never, '/repo', '   \n  \t ');
    expect(monitor.todoAdd).not.toHaveBeenCalled();
    expect(signalled).toBe(0);
  });

  it('empty/whitespace command output is not persisted and signals nothing (empty-guard)', async () => {
    listen();
    const monitor = makeMonitor({
      commands: vi.fn(async () => [
        { id: 'c', sessionId: 's1', command: 'x', exitCode: 0, running: false, startedAt: 0, truncated: false },
      ]),
      captureCommandText: vi.fn(async () => ({ text: '   \n ', truncated: false })),
    });
    await captureToTodo(monitor as never, '/repo', null);
    expect(monitor.todoAdd).not.toHaveBeenCalled();
    expect(signalled).toBe(0);
  });

  it('without a repo key: no-op (todos are repo-scoped)', async () => {
    listen();
    const monitor = makeMonitor();
    await captureToTodo(monitor as never, null, 'x');
    expect(monitor.todoAdd).not.toHaveBeenCalled();
    expect(signalled).toBe(0);
  });
});
