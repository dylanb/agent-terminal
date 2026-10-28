// Busy controls are marked `aria-disabled`, never `disabled`: `disabled` blurs the pressed control to <body>
// for the whole round-trip, so focus and any progress announcement would land nowhere (WCAG 2.4.3, 4.1.2).

import { createSpinner } from './spinner';

/** A returned promise holds the group until it settles. */
export type PressAction = () => unknown;

/** Presses the control it came from, through the group's guard. Calling it in teardown runs the action. */
export type GuardedPress = () => void;

/** Detaches what `within` attached. */
export type Unbind = () => void;

export interface BindOptions {
  /** Names the logical control, so one rebuilt while its press is pending shows busy in its place. */
  key?: string;
}

export interface PressGroup {
  /** The returned press serves other triggers, such as Enter in a field. */
  bind(control: HTMLElement, action: PressAction, opts?: BindOptions): GuardedPress;
  /** For controls other components add to `root` after this call. */
  within(root: HTMLElement, pick: (target: Element) => { control: HTMLElement; action: PressAction } | null): Unbind;
  /** Runs work a press starts only after a confirmation as a press of the control that asked for it. */
  run(control: HTMLElement, action: PressAction): void;
  readonly busy: boolean;
}

function report(control: HTMLElement, e: unknown): void {
  const win = control.ownerDocument.defaultView;
  const event = win ? new win.ErrorEvent('error', { error: e, message: e instanceof Error ? e.message : String(e), cancelable: true }) : null;
  if (!win || !event || win.dispatchEvent(event)) console.error(e);
}

export function createPressGroup(): PressGroup {
  const members = new Map<HTMLElement, string | undefined>();
  const priorUnavailable = new Map<HTMLElement, string | null>();
  const spinners = new Map<HTMLElement, HTMLElement>();
  let busy = false;
  let busyKey: string | undefined;
  let pruneScheduled = false;

  // Controls are usually bound before they are attached, so a prune at bind time would drop siblings.
  function schedulePrune(): void {
    if (pruneScheduled) return;
    pruneScheduled = true;
    queueMicrotask(() => {
      pruneScheduled = false;
      for (const control of members.keys()) if (!control.isConnected) members.delete(control);
    });
  }

  function hold(control: HTMLElement): void {
    if (!priorUnavailable.has(control)) priorUnavailable.set(control, control.getAttribute('aria-disabled'));
    control.setAttribute('aria-disabled', 'true');
  }

  function showBusy(control: HTMLElement): void {
    if (spinners.has(control)) return;
    control.setAttribute('aria-busy', 'true');
    const spinner = createSpinner(control.ownerDocument);
    control.append(spinner);
    spinners.set(control, spinner);
  }

  function busyTarget(pressed: HTMLElement): HTMLElement {
    if (pressed.isConnected) return pressed;
    const focused = pressed.ownerDocument.activeElement;
    return focused instanceof HTMLElement && focused.isConnected && members.has(focused) ? focused : pressed;
  }

  function release(): void {
    busy = false;
    busyKey = undefined;
    for (const [control, spinner] of spinners) {
      spinner.remove();
      control.removeAttribute('aria-busy');
    }
    spinners.clear();
    for (const [control, prior] of priorUnavailable) {
      if (prior === null) control.removeAttribute('aria-disabled');
      else control.setAttribute('aria-disabled', prior);
    }
    priorUnavailable.clear();
    schedulePrune();
  }

  function run(control: HTMLElement, action: PressAction): void {
    if (busy) return;
    let result: unknown;
    try {
      result = action();
    } catch (e) {
      report(control, e);
      return;
    }
    if (!(result instanceof Promise)) return;
    busy = true;
    const target = busyTarget(control);
    busyKey = members.get(target);
    for (const member of members.keys()) hold(member);
    showBusy(target);
    result.then(release, (e: unknown) => {
      release();
      report(control, e);
    });
  }

  const pressFrom = (control: HTMLElement, action: PressAction) => (e: Event): void => {
    if (control.tagName === 'A') e.preventDefault();
    run(control, action);
  };

  return {
    bind(control, action, opts) {
      members.set(control, opts?.key);
      schedulePrune();
      if (busy) {
        hold(control);
        if (opts?.key !== undefined && opts.key === busyKey) showBusy(control);
      }
      control.addEventListener('click', pressFrom(control, action));
      return () => run(control, action);
    },
    within(root, pick) {
      const onClick = (e: Event): void => {
        const found = e.target instanceof Element ? pick(e.target) : null;
        if (found) pressFrom(found.control, found.action)(e);
      };
      root.addEventListener('click', onClick);
      return () => root.removeEventListener('click', onClick);
    },
    run,
    get busy() {
      return busy;
    },
  };
}

/** A group of one; returns the guarded press. */
export function onPress(control: HTMLElement, action: PressAction): GuardedPress {
  return createPressGroup().bind(control, action);
}
