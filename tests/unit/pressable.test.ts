// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createPressGroup, onPress } from '../../src/renderer/src/pressable';

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (e: unknown) => void } {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('pressable — a control ignores presses while its action, or a related one, is still running', () => {
  let host: HTMLElement;
  let reported: unknown[];
  const onError = (e: ErrorEvent): void => {
    reported.push(e.error);
  };
  beforeEach(() => {
    host = document.createElement('div');
    document.body.replaceChildren(host);
    reported = [];
    window.addEventListener('error', onError);
  });
  afterEach(() => {
    window.removeEventListener('error', onError);
  });

  function button(label: string): HTMLButtonElement {
    const b = document.createElement('button');
    b.textContent = label;
    host.append(b);
    return b;
  }

  it('runs a second press only after the first action settles', async () => {
    const save = button('Save');
    const pending = deferred();
    let runs = 0;
    onPress(save, () => {
      runs += 1;
      return pending.promise;
    });

    save.click();
    save.click();
    save.click();
    expect(runs).toBe(1);

    pending.resolve();
    await settle();
    save.click();
    expect(runs).toBe(2);
  });

  it('ignores every control in the group while one of its actions runs, and leaves other controls alone', async () => {
    const group = createPressGroup();
    const approve = button('Approve');
    const reject = button('Request changes');
    const other = button('Other');
    const pending = deferred();
    const ran: string[] = [];
    group.bind(approve, () => {
      ran.push('approve');
      return pending.promise;
    });
    group.bind(reject, () => {
      ran.push('reject');
    });
    onPress(other, () => {
      ran.push('other');
    });

    approve.click();
    reject.click();
    other.click();
    expect(ran).toEqual(['approve', 'other']);

    pending.resolve();
    await settle();
    reject.click();
    expect(ran).toEqual(['approve', 'other', 'reject']);
  });

  it('shows the pressed control as busy with a spinner and the group as unavailable, then restores both', async () => {
    const group = createPressGroup();
    const approve = button('Approve');
    const reject = button('Request changes');
    reject.setAttribute('aria-disabled', 'false');
    const pending = deferred();
    group.bind(approve, () => pending.promise);
    group.bind(reject, () => undefined);

    approve.click();
    expect({
      approveBusy: approve.getAttribute('aria-busy'),
      approveUnavailable: approve.getAttribute('aria-disabled'),
      rejectBusy: reject.getAttribute('aria-busy'),
      rejectUnavailable: reject.getAttribute('aria-disabled'),
      approveSpinners: approve.querySelectorAll('.spin[aria-hidden="true"]').length,
      rejectSpinners: reject.querySelectorAll('.spin').length,
    }).toEqual({
      approveBusy: 'true',
      approveUnavailable: 'true',
      rejectBusy: null,
      rejectUnavailable: 'true',
      approveSpinners: 1,
      rejectSpinners: 0,
    });

    pending.resolve();
    await settle();
    expect({
      approveBusy: approve.getAttribute('aria-busy'),
      approveUnavailable: approve.getAttribute('aria-disabled'),
      rejectUnavailable: reject.getAttribute('aria-disabled'),
      approveSpinners: approve.querySelectorAll('.spin').length,
      approveText: approve.textContent,
    }).toEqual({
      approveBusy: null,
      approveUnavailable: null,
      rejectUnavailable: 'false',
      approveSpinners: 0,
      approveText: 'Approve',
    });
  });


  it('releases the group when the action rejects or throws', async () => {
    const group = createPressGroup();
    const failing = button('Failing');
    const throwing = button('Throwing');
    const pending = deferred();
    let runs = 0;
    group.bind(failing, () => {
      runs += 1;
      return pending.promise;
    });
    group.bind(throwing, () => {
      runs += 1;
      throw new Error('boom');
    });

    failing.click();
    pending.reject(new Error('ipc gone'));
    await settle();
    expect(failing.getAttribute('aria-busy')).toBeNull();

    expect(() => throwing.click()).not.toThrow();
    failing.click();
    expect(runs).toBe(3);
  });

  it('reports a failed action as an uncaught error rather than swallowing it', async () => {
    const rejected = new Error('ipc gone');
    const thrown = new Error('boom');
    onPress(button('Rejects'), () => Promise.reject(rejected)).call(null);
    onPress(button('Throws'), () => {
      throw thrown;
    }).call(null);
    await settle();
    expect(reported).toEqual([thrown, rejected]);
  });

  it('treats an action that returns no promise as finished at once', () => {
    const toggle = button('Toggle');
    let runs = 0;
    onPress(toggle, () => {
      runs += 1;
    });
    toggle.click();
    expect(toggle.getAttribute('aria-busy')).toBeNull();
    toggle.click();
    expect(runs).toBe(2);
  });

  it('a control bound while its group is busy starts unavailable and is released with the group', async () => {
    const group = createPressGroup();
    const first = button('First');
    const pending = deferred();
    group.bind(first, () => pending.promise);
    first.click();

    const rebuilt = button('Rebuilt');
    let rebuiltRuns = 0;
    group.bind(rebuilt, () => {
      rebuiltRuns += 1;
    });
    rebuilt.click();
    expect({ unavailable: rebuilt.getAttribute('aria-disabled'), runs: rebuiltRuns }).toEqual({ unavailable: 'true', runs: 0 });

    pending.resolve();
    await settle();
    rebuilt.click();
    expect({ unavailable: rebuilt.getAttribute('aria-disabled'), runs: rebuiltRuns }).toEqual({ unavailable: null, runs: 1 });
  });

  it('presses on controls a container recognises, including ones added later, run through the same guard', async () => {
    const group = createPressGroup();
    const pending = deferred();
    const ran: string[] = [];
    group.within(host, (target) => {
      const control = target.closest<HTMLElement>('[data-act]');
      if (!control) return null;
      const name = control.getAttribute('data-act') ?? '';
      return {
        control,
        action: () => {
          ran.push(name);
          return name === 'slow' ? pending.promise : undefined;
        },
      };
    });
    const slow = button('Slow');
    slow.setAttribute('data-act', 'slow');
    const quick = button('Quick');
    quick.setAttribute('data-act', 'quick');
    const label = document.createElement('span');
    label.textContent = 'inside';
    quick.append(label);
    button('Unrecognised').click();

    label.click();
    slow.click();
    slow.click();
    quick.click();
    expect({ ran, busy: slow.getAttribute('aria-busy') }).toEqual({ ran: ['quick', 'slow'], busy: 'true' });

    pending.resolve();
    await settle();
    quick.click();
    expect({ ran, busy: slow.getAttribute('aria-busy') }).toEqual({ ran: ['quick', 'slow', 'quick'], busy: null });
  });

  it('work started after a confirmation runs as a press of the control that asked for it', async () => {
    const group = createPressGroup();
    const terminate = button('Terminate');
    const advance = button('Advance');
    const pending = deferred();
    const ran: string[] = [];
    group.bind(terminate, () => {
      ran.push('ask');
    });
    group.bind(advance, () => {
      ran.push('advance');
    });

    group.run(terminate, () => {
      ran.push('terminate');
      return pending.promise;
    });
    group.run(terminate, () => {
      ran.push('terminate again');
    });
    advance.click();
    expect({ ran, busy: terminate.getAttribute('aria-busy'), spinners: terminate.querySelectorAll('.spin').length }).toEqual({
      ran: ['terminate'],
      busy: 'true',
      spinners: 1,
    });

    pending.resolve();
    await settle();
    advance.click();
    expect(ran).toEqual(['terminate', 'advance']);
  });

  it('shows busy on the group control focus moved to when the press rebuilt the pressed one away', async () => {
    const group = createPressGroup();
    const pending = deferred();
    const trigger = button('Flow: a');
    const option = button('flow-b');
    group.bind(trigger, () => undefined);
    group.bind(option, () => {
      option.remove();
      trigger.remove();
      const rebuilt = button('Flow: b');
      group.bind(rebuilt, () => undefined);
      rebuilt.focus();
      return pending.promise;
    });

    option.click();
    const shown = (): Element | null => host.querySelector('[aria-busy="true"]');
    expect({ text: shown()?.textContent?.startsWith('Flow: b'), spinners: shown()?.querySelectorAll('.spin').length }).toEqual({
      text: true,
      spinners: 1,
    });
    pending.resolve();
    await settle();
    expect({ busy: shown(), spinners: host.querySelectorAll('.spin').length }).toEqual({ busy: null, spinners: 0 });
  });

  it('a control rebuilt under the same key while its press is pending shows busy, and is released with it', async () => {
    const group = createPressGroup();
    const pending = deferred();
    const save = button('Save');
    group.bind(save, () => pending.promise, { key: 'save:1' });
    const other = button('Delete');
    group.bind(other, () => undefined, { key: 'delete:1' });
    save.click();

    save.remove();
    other.remove();
    const saveAgain = button('Save');
    group.bind(saveAgain, () => pending.promise, { key: 'save:1' });
    const otherAgain = button('Delete');
    group.bind(otherAgain, () => undefined, { key: 'delete:1' });
    expect({
      saveBusy: saveAgain.getAttribute('aria-busy'),
      saveSpinners: saveAgain.querySelectorAll('.spin').length,
      otherBusy: otherAgain.getAttribute('aria-busy'),
      otherUnavailable: otherAgain.getAttribute('aria-disabled'),
    }).toEqual({ saveBusy: 'true', saveSpinners: 1, otherBusy: null, otherUnavailable: 'true' });

    pending.resolve();
    await settle();
    expect({ busy: saveAgain.getAttribute('aria-busy'), spinners: host.querySelectorAll('.spin').length }).toEqual({ busy: null, spinners: 0 });
  });

  it('forgets controls a re-render removed, even in a group that has never been busy', async () => {
    const group = createPressGroup();
    const removed: HTMLButtonElement[] = [];
    for (let render = 0; render < 3; render += 1) {
      const row = document.createElement('div');
      const decide = document.createElement('button');
      decide.textContent = `Decide ${render}`;
      group.bind(decide, () => undefined);
      row.append(decide);
      host.replaceChildren(row);
      if (render < 2) removed.push(decide);
      await settle();
    }
    const pending = deferred();
    const slow = button('Slow');
    group.bind(slow, () => pending.promise);
    slow.click();
    expect(removed.map((b) => b.getAttribute('aria-disabled'))).toEqual([null, null]);
    pending.resolve();
    await settle();
  });

  it('a pressed link runs its action instead of navigating the window', () => {
    const link = document.createElement('a');
    link.href = 'https://example.com/pr/1';
    link.textContent = '#1';
    host.append(link);
    let runs = 0;
    onPress(link, () => {
      runs += 1;
    });
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    link.dispatchEvent(click);
    expect({ runs, navigationCancelled: click.defaultPrevented }).toEqual({ runs: 1, navigationCancelled: true });
  });

  it('a press from another trigger (Enter in a field) shares the same guard', async () => {
    const add = button('Add');
    const pending = deferred();
    let runs = 0;
    const press = onPress(add, () => {
      runs += 1;
      return pending.promise;
    });

    press();
    add.click();
    press();
    expect({ runs, busy: add.getAttribute('aria-busy') }).toEqual({ runs: 1, busy: 'true' });
    pending.resolve();
    await settle();
    press();
    expect(runs).toBe(2);
  });
});
