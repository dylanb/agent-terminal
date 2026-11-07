/// <reference lib="dom" />
import { createControllerPanes } from '../../src/renderer/src/controllerPanes';
import type { ControllerApi, ControllerTerminal, Theme } from '../../src/shared/ipc';
import { statusService, type SortMode } from './controllerStatusFixture';

/** The `layout` dependency's fake: whether the window is in the one-column layout, flipped by the test. */
export function fakeLayout(oneColumn = false) {
  const listeners = new Set<() => void>();
  let current = oneColumn;
  const layout = {
    oneColumn: () => current,
    onChange(listener: () => void): () => void {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
  return {
    layout,
    /** Whether any listener is still subscribed to layout changes. */
    following: (): boolean => listeners.size > 0,
    set(next: boolean): void {
      current = next;
      listeners.forEach(listener => listener());
    },
  };
}

/** The `clock` dependency's fake: time moves only when the test moves it. */
export function fakeControllerClock(start = 1_000_000_000) {
  const listeners = new Set<() => void>();
  let current = start;
  const clock = {
    now: () => current,
    onTick(listener: () => void): () => void {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
  return {
    clock,
    /** Whether any listener is still subscribed to ticks. */
    ticking: (): boolean => listeners.size > 0,
    /** Moves the clock by `ms` (negative for a wall clock stepped back), then fires one tick. */
    advance(ms: number): void {
      if (!Number.isFinite(ms)) throw new RangeError(`advance needs a finite ms; got ${ms}`);
      current += ms;
      [...listeners].forEach(listener => listener());
    },
  };
}
export type FakeControllerClock = ReturnType<typeof fakeControllerClock>;

/** The `windowFocus` dependency's fake: whether the controller window itself has focus, flipped by the test. */
export function fakeWindowFocus(focused = true) {
  const listeners = new Set<() => void>();
  let current = focused;
  const windowFocus = {
    focused: () => current,
    onChange(listener: () => void): () => void {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
  return {
    windowFocus,
    /** Whether any listener is still subscribed to window focus changes. */
    following: (): boolean => listeners.size > 0,
    set(next: boolean): void {
      current = next;
      [...listeners].forEach(listener => listener());
    },
  };
}
export type FakeWindowFocus = ReturnType<typeof fakeWindowFocus>;

type StatusService = ReturnType<typeof statusService>;
interface MountOptions {
  terminals?: ControllerTerminal[];
  oneColumn?: boolean;
  parent?: HTMLElement;
  /** The theme the controller fake holds as saved; `unreadable` makes reading it reject. */
  theme?: Theme | 'unreadable';
  /** The always-on-top value the controller fake holds; `unreadable` makes reading it reject. */
  alwaysOnTop?: boolean | 'unreadable';
  alwaysOnTopReply?: 'applied' | 'refused' | 'rejected';
  /** The card order the controller fake holds as saved; `unreadable` makes reading it reject. */
  sortMode?: SortMode | 'unreadable';
  sortModeSave?: 'saved' | 'rejected';
  clock?: FakeControllerClock;
  /** Whether the controller window itself starts focused (default true). */
  windowFocused?: boolean;
}
interface Mounted {
  host: HTMLElement;
  layout: ReturnType<typeof fakeLayout>;
  clock: FakeControllerClock;
  windowFocus: FakeWindowFocus;
  /** Each theme the organism painted on the document, in order. */
  applied: Theme[];
  dispose(): void;
}

/** Mounts the controller organism with the default fake for every dependency; a test overrides what it needs. */
export function mountControllerPanes(options?: MountOptions & { controller?: undefined }): Mounted & { service: StatusService };
export function mountControllerPanes(options: Omit<MountOptions, 'terminals'> & { controller: ControllerApi; terminals?: never }): Mounted & { service: undefined };
export function mountControllerPanes(options: MountOptions & { controller?: ControllerApi } = {}): Mounted & { service: StatusService | undefined } {
  const host = document.createElement('main');
  (options.parent ?? document.body).append(host);
  const service = options.controller ? undefined : statusService(options.terminals, {
    theme: options.theme, sortMode: options.sortMode, sortModeSave: options.sortModeSave, alwaysOnTop: options.alwaysOnTop, alwaysOnTopReply: options.alwaysOnTopReply,
  });
  const layout = fakeLayout(options.oneColumn);
  const clock = options.clock ?? fakeControllerClock();
  const windowFocus = fakeWindowFocus(options.windowFocused);
  const applied: Theme[] = [];
  const deps = {
    controller: options.controller ?? service!.api, layout: layout.layout, applyTheme: (theme: Theme) => { applied.push(theme); },
    clock: clock.clock, windowFocus: windowFocus.windowFocus,
  };
  const panes = createControllerPanes(host, deps);
  return {
    host, service, layout, clock, windowFocus, applied,
    dispose() {
      panes.dispose();
      host.remove();
    },
  };
}
