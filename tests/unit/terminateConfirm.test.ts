import { describe, expect, it, vi } from 'vitest';
import { createTerminateConfirm } from '../../src/renderer/src/terminateConfirm';
import type { ConfirmDialog, ConfirmDialogOptions } from '../../src/renderer/src/confirmDialog';

// The composition root's Terminate seam (#26 AC3): it surfaces the repo's activation-time todo count
// in the destructive confirmation and gates the IPC terminate behind the user's confirm. Observable
// behavior = the ConfirmDialogOptions handed to the dialog (its count message + onConfirm), or that
// no dialog is opened when the count lookup fails.

function fakeDialog(): { dialog: ConfirmDialog; rendered: Array<ConfirmDialogOptions | null> } {
  const rendered: Array<ConfirmDialogOptions | null> = [];
  return { dialog: { render: (o) => rendered.push(o), dispose: () => {} }, rendered };
}

const withCount = (n: number) => async (): Promise<unknown[]> => Array.from({ length: n }, () => ({}));

describe('terminate confirmation seam (#26 AC3)', () => {
  it('states "1 todo" (singular) when the repo has exactly one todo', async () => {
    const { dialog, rendered } = fakeDialog();
    createTerminateConfirm({ todoList: withCount(1), dialog })('/repo', vi.fn());
    await vi.waitFor(() => expect(rendered).toHaveLength(1));
    expect(rendered[0]!.message).toContain('deletes 1 todo for this repository');
    expect(rendered[0]!.message).not.toContain('1 todos');
  });

  it('states "N todos" (plural) for zero and for many', async () => {
    for (const [n, fragment] of [[0, '0 todos'], [3, '3 todos']] as const) {
      const { dialog, rendered } = fakeDialog();
      createTerminateConfirm({ todoList: withCount(n), dialog })('/repo', vi.fn());
      await vi.waitFor(() => expect(rendered).toHaveLength(1));
      expect(rendered[0]!.message).toContain(fragment);
    }
  });

  it('counts the activated repo and renders a destructive Terminate confirmation', async () => {
    const { dialog, rendered } = fakeDialog();
    const todoList = vi.fn(withCount(2));
    createTerminateConfirm({ todoList, dialog })('/repo-x', vi.fn());
    await vi.waitFor(() => expect(rendered).toHaveLength(1));
    expect(todoList).toHaveBeenCalledWith('/repo-x'); // the deterministic activation-time count is the activated repo's
    expect(rendered[0]!.title).toBe('Terminate flow');
    expect(rendered[0]!.confirmLabel).toBe('Terminate');
    expect(rendered[0]!.message).toContain('2 todos');
  });

  it('passes the user confirm through as the dialog onConfirm so confirming drives the terminate', async () => {
    const { dialog, rendered } = fakeDialog();
    const confirm = vi.fn();
    createTerminateConfirm({ todoList: withCount(0), dialog })('/repo', confirm);
    await vi.waitFor(() => expect(rendered).toHaveLength(1));
    expect(confirm).not.toHaveBeenCalled(); // nothing fires until the user confirms
    rendered[0]!.onConfirm();
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it('keeps the dialog closed when the count lookup rejects (no dialog, no unhandled rejection)', async () => {
    const { dialog, rendered } = fakeDialog();
    createTerminateConfirm({ todoList: async () => { throw new Error('ipc down'); }, dialog })('/repo', vi.fn());
    await new Promise((r) => setTimeout(r, 0));
    expect(rendered).toEqual([]); // a rejected count never opens the destructive dialog
  });
});
