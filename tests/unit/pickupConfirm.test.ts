// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPickupConfirm } from '../../src/renderer/src/pickupConfirm';
import { assertRendersFromHostDocument } from './relocatable';
import type { ConfirmRunPickupResult, FlowStateView, PickupConfirmView } from '../../src/shared/ipc';
import type { FlowViewArgs } from '../../src/renderer/src/flowView';

// §27.13 — a run held for its ticket and pull request asks the operator to confirm (or correct) what the app
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

let focusLost: number;
let terminal: HTMLInputElement;

beforeEach(() => {
  document.body.innerHTML = '<input id="terminal"><div id="h"></div><div id="m"></div>';
  host = document.getElementById('h')!;
  modalHost = document.getElementById('m')!;
  terminal = document.getElementById('terminal') as HTMLInputElement;
  focusLost = 0;
  confirm = vi.fn(async () => ({ ok: true }) as ConfirmRunPickupResult);
  createPickupConfirm(host, {
    modalHost,
    onView: (cb) => {
      push = cb;
      return () => {};
    },
    confirm,
    onFocusLost: () => {
      focusLost += 1;
    },
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

  it('refuses a number too large to be a pull request or ticket, without asking main', async () => {
    push('/repo', view(proposed()));
    field('Pull request').value = '99999999999999999999';
    button(dialog()!, 'Confirm').click();
    await flush();
    expect(confirm).not.toHaveBeenCalled();
    expect(dialog()!.querySelector('[role="alert"]')?.textContent).toContain('as numbers');
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

describe('the dialog’s accessibility (UI-STANDARDS §4.5–§4.6, §5; WCAG 2.4.3, 1.3.1)', () => {
  it('is labelled by its title and described by its text and the problems found', () => {
    push('/repo', view(proposed({ problems: ['GitHub has no open pull request for plan-loop/issue-218.'] })));
    const d = dialog()!;
    expect(document.getElementById(d.getAttribute('aria-labelledby')!)?.textContent).toContain('ticket and pull request');
    const described = d.getAttribute('aria-describedby')!.split(' ').map((id) => document.getElementById(id)?.textContent ?? '').join(' ');
    expect(described).toContain('This run is past its pickup');
    expect(described).toContain('GitHub has no open pull request');
  });

  it('starts on the pull request field when something did not line up, and on Confirm when nothing did', () => {
    push('/repo', view(proposed({ problems: ['GitHub has no open pull request for plan-loop/issue-218.'] })));
    expect(document.activeElement).toBe(field('Pull request'));
    button(dialog()!, 'Not now').click();
    push('/repo', view(proposed({ run: { ...RUN, startedAt: RUN.startedAt + 1 } })));
    expect(document.activeElement).toBe(button(dialog()!, 'Confirm'));
  });

  it('Tab wraps inside the dialog', () => {
    push('/repo', view(proposed()));
    const confirmButton = button(dialog()!, 'Confirm');
    confirmButton.focus();
    dialog()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(dialog()!.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(confirmButton);
  });

  it.each([
    ['“Not now”', () => button(dialog()!, 'Not now').click()],
    ['Escape', () => dialog()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))],
  ])('the dialog the app raised returns focus to where the operator was when %s closes it', (_name, closeIt) => {
    terminal.focus();
    push('/repo', view(proposed()));
    closeIt();
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(terminal);
  });

  it('a confirm that lands returns focus to where the operator was', async () => {
    terminal.focus();
    push('/repo', view(proposed()));
    button(dialog()!, 'Confirm').click();
    await flush();
    expect(document.activeElement).toBe(terminal);
  });

  it('a refused confirm returns focus to Confirm, inside the dialog, after the wait blurs it', async () => {
    push('/repo', view(proposed()));
    const ok = button(dialog()!, 'Confirm');
    ok.focus();
    confirm.mockImplementationOnce(async () => {
      const elsewhere = document.body.appendChild(document.createElement('input'));
      elsewhere.focus();
      elsewhere.remove();
      return { ok: false, reason: 'pull request #233 is not open (closed)' };
    });
    ok.click();
    await flush();
    expect(document.activeElement).toBe(ok);
  });

  it('a confirm call that fails is reported in the dialog, and Confirm can be used again', async () => {
    confirm.mockRejectedValueOnce(new Error('the app could not reach its main process'));
    push('/repo', view(proposed()));
    const ok = button(dialog()!, 'Confirm');
    ok.click();
    await flush();
    expect(dialog()!.querySelector('[role="alert"]')?.textContent).toContain('could not reach its main process');
    ok.click();
    await flush();
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  it('ignores Confirm and Not now while a confirm is still being answered, and shows Confirm busy', async () => {
    let answer!: (r: ConfirmRunPickupResult) => void;
    confirm.mockImplementationOnce(() => new Promise((res) => (answer = res)));
    push('/repo', view(proposed()));
    const ok = button(dialog()!, 'Confirm');
    ok.click();
    ok.click();
    button(dialog()!, 'Not now').click();
    document.querySelector('.flow-modal')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    document.querySelector<HTMLElement>('.flow-scrim')?.click();
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(dialog()).not.toBeNull();
    expect(ok.getAttribute('aria-busy')).toBe('true');
    answer({ ok: false, reason: 'pull request #233 is not open (closed)' });
    await flush();
    expect(ok.getAttribute('aria-busy')).toBeNull();
    ok.click();
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  it('a refresh of the side-panel line keeps focus on its button', () => {
    push('/repo', view(proposed()));
    button(dialog()!, 'Not now').click();
    button(host, 'Confirm ticket and PR').focus();
    push('/repo', view(proposed()));
    expect(document.activeElement).toBe(button(host, 'Confirm ticket and PR'));
  });

  it('a dialog opened from the side-panel button returns focus to it after a refresh lands while the dialog is open', () => {
    push('/repo', view(proposed()));
    button(dialog()!, 'Not now').click();
    const opener = button(host, 'Confirm ticket and PR');
    opener.focus();
    opener.click();
    push('/repo', view(proposed()));
    dialog()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.activeElement).toBe(button(host, 'Confirm ticket and PR'));
    expect(focusLost).toBe(0);
  });

  it('the side-panel button opens the dialog for the latest proposal', () => {
    push('/repo', view(proposed()));
    button(dialog()!, 'Not now').click();
    push('/repo', view(proposed({ pr: 240 })));
    button(host, 'Confirm ticket and PR').click();
    expect(field('Pull request').value).toBe('240');
  });

  it('clearing the side-panel line while focus is on it hands focus to the fallback', () => {
    push('/repo', view(proposed()));
    button(dialog()!, 'Not now').click();
    button(host, 'Confirm ticket and PR').focus();
    push('/repo', view());
    expect(focusLost).toBe(1);
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
