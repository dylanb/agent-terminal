// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { captureToTodo } from '../../src/renderer/src/selection';
import { TODOS_CHANGED_EVENT } from '../../src/renderer/src/monitor';
import { cleanSelectionText } from '../../src/renderer/src/selectionModel';

function makeMonitor(over: Partial<Record<string, ReturnType<typeof vi.fn>>> = {}) {
  return {
    todoAdd: vi.fn(async () => []),
    ...over,
  };
}

describe('captureToTodo (§16.2 — text straight to the repo-scoped Todo list, cross-pane refresh)', () => {
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

  it('adds the cleaned text as a selection todo and signals a change', async () => {
    listen();
    const monitor = makeMonitor();
    await captureToTodo(monitor as never, '/repo', '  pick this up  ');
    expect(monitor.todoAdd).toHaveBeenCalledWith('/repo', cleanSelectionText('  pick this up  '), {
      type: 'selection',
    });
    expect(signalled).toBe(1);
  });

  it('a rejected IPC invoke is swallowed (no unhandled rejection) and no change is signalled', async () => {
    // A main-process restart can reject todoAdd; the detached `void captureToTodo(...)` call sites
    // must not surface an unhandled rejection. vitest fails the run on one, so this pins the catch.
    listen();
    const monitor = makeMonitor({ todoAdd: vi.fn(async () => { throw new Error('ipc down'); }) });
    await expect(captureToTodo(monitor as never, '/repo', 'x')).resolves.toBeUndefined();
    expect(signalled).toBe(0);
  });

  it('text that cleans to empty is not persisted and signals nothing (empty-guard)', async () => {
    listen();
    const monitor = makeMonitor();
    await captureToTodo(monitor as never, '/repo', '   \n  \t ');
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
