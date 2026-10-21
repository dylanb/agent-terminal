// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPickupConfirm } from '../../src/renderer/src/pickupConfirm';
import { assertRendersFromHostDocument } from './relocatable';
import type { ConfirmRunPickupResult, FlowStateView, PickupConfirmView } from '../../src/shared/ipc';
import type { FlowViewArgs } from '../../src/renderer/src/flowView';

// §27.13 v2.211 — a run held for its ticket and pull request asks the operator to confirm (or correct) what the app
// found, and keeps asking until a confirm GitHub backs.

const RUN = { flow: 'feature-dev-v3', startedAt: 1792407818398 };
const proposed = (over: Partial<Extract<PickupConfirmView, { state: 'proposed' }>> = {}): PickupConfirmView => ({
  run: RUN,
  state: 'proposed',
  branch: 'plan-loop/issue-218',
  pr: 233,
  ticket: 218,
  problems: [],
  ...over,
});
const view = (pickupConfirm?: PickupConfirmView): FlowStateView => ({ ...({} as FlowStateView), ...(pickupConfirm ? { pickupConfirm } : {}) });

let host: HTMLElement;
let modalHost: HTMLElement;
let push: (...args: FlowViewArgs) => void;
let confirm: ReturnType<typeof vi.fn<(repoKey: string, run: typeof RUN, pr: number, ticket: number) => Promise<ConfirmRunPickupResult>>>;

beforeEach(() => {
  document.body.innerHTML = '<div id="h"></div><div id="m"></div>';
  host = document.getElementById('h')!;
  modalHost = document.getElementById('m')!;
  confirm = vi.fn(async () => ({ ok: true }) as ConfirmRunPickupResult);
  createPickupConfirm(host, {
    modalHost,
    onView: (cb) => {
      push = cb;
      return () => {};
    },
    confirm,
  });
});

const dialog = (): HTMLElement | null => modalHost.querySelector('[role="alertdialog"]');
const field = (name: string): HTMLInputElement => {
  const input = [...modalHost.querySelectorAll('input')].find((i) => i.getAttribute('aria-label') === name);
  if (!input) throw new Error(`no ${name} field`);
  return input;
};
const button = (root: HTMLElement, text: string): HTMLButtonElement => {
  const b = [...root.querySelectorAll('button')].find((x) => x.textContent?.trim().startsWith(text));
  if (!b) throw new Error(`no ${text} button`);
  return b;
};
const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

describe('a run that needs no confirm', () => {
  it('shows nothing', () => {
    push('/repo', view());
    expect(host.textContent).toBe('');
    expect(dialog()).toBeNull();
  });
});

describe('while the app looks the run’s ticket and pull request up', () => {
  it('says so, and opens no dialog yet', () => {
    push('/repo', view({ run: RUN, state: 'looking' }));
    expect(host.textContent).toMatch(/Looking up/);
    expect(dialog()).toBeNull();
  });
});

describe('the confirm dialog', () => {
  it('opens on its own with what was found, editable, and any problem named', () => {
    push('/repo', view(proposed({ problems: ['GitHub has no open pull request for plan-loop/issue-218.'] })));
    expect(dialog()).not.toBeNull();
    expect(dialog()!.textContent).toContain('ticket and pull request');
    expect(dialog()!.textContent).toContain('plan-loop/issue-218');
    expect(dialog()!.textContent).toContain('GitHub has no open pull request');
    expect(field('Pull request').value).toBe('233');
    expect(field('Ticket').value).toBe('218');
  });

  it('leaves a field empty when nothing was found for it', () => {
    push('/repo', view(proposed({ pr: null })));
    expect(field('Pull request').value).toBe('');
  });

  it('confirms the numbers the operator settles on, for the run it was shown', async () => {
    push('/repo', view(proposed()));
    field('Pull request').value = ' 240 ';
    button(dialog()!, 'Confirm').click();
    await flush();
    expect(confirm).toHaveBeenCalledWith('/repo', RUN, 240, 218);
    expect(dialog()).toBeNull();
  });

  it('stays open with the reason when GitHub does not back the numbers', async () => {
    confirm.mockResolvedValueOnce({ ok: false, reason: 'pull request #233 does not close ticket #218' });
    push('/repo', view(proposed()));
    button(dialog()!, 'Confirm').click();
    await flush();
    expect(dialog()).not.toBeNull();
    expect(dialog()!.querySelector('[role="alert"]')?.textContent).toContain('does not close ticket #218');
  });

  it('refuses a field that is not a number, without asking main', async () => {
    push('/repo', view(proposed()));
    field('Ticket').value = '#218';
    button(dialog()!, 'Confirm').click();
    await flush();
    expect(confirm).not.toHaveBeenCalled();
    expect(dialog()!.querySelector('[role="alert"]')?.textContent).not.toBe('');
  });

  it('“Not now” closes it, leaves a way back to it, and later views of the same run do not reopen it', () => {
    push('/repo', view(proposed()));
    button(dialog()!, 'Not now').click();
    expect(dialog()).toBeNull();
    push('/repo', view(proposed()));
    expect(dialog()).toBeNull();
    button(host, 'Confirm ticket and PR').click();
    expect(dialog()).not.toBeNull();
  });

  it('opens again for a different run', () => {
    push('/repo', view(proposed()));
    button(dialog()!, 'Not now').click();
    push('/repo', view(proposed({ run: { ...RUN, startedAt: RUN.startedAt + 1 } })));
    expect(dialog()).not.toBeNull();
  });

  it('closes, and the strip clears, once the run no longer needs a confirm', () => {
    push('/repo', view(proposed()));
    push('/repo', view());
    expect(dialog()).toBeNull();
    expect(host.textContent).toBe('');
  });

  it('closes when the strip moves to another worktree', () => {
    push('/repo', view(proposed()));
    push(null, null);
    expect(dialog()).toBeNull();
    expect(host.textContent).toBe('');
  });
});

describe('relocation (UI-STANDARDS §3.3)', () => {
  it('builds from its host’s document', async () => {
    await assertRendersFromHostDocument((foreignHost) => {
      let cb: ((...args: FlowViewArgs) => void) | undefined;
      createPickupConfirm(foreignHost, {
        modalHost: foreignHost,
        onView: (fn) => {
          cb = fn;
          return () => {};
        },
        confirm,
      });
      cb?.('/repo', view(proposed()));
    });
  });
});
