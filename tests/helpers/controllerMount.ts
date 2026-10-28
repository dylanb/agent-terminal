/// <reference lib="dom" />
import { createControllerPanes } from '../../src/renderer/src/controllerPanes';
import type { ControllerApi, ControllerTerminal, Theme } from '../../src/shared/ipc';
import { statusService } from './controllerStatusFixture';

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
}
interface Mounted {
  host: HTMLElement;
  layout: ReturnType<typeof fakeLayout>;
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
  const service = options.controller ? undefined : statusService(options.terminals, { theme: options.theme, alwaysOnTop: options.alwaysOnTop, alwaysOnTopReply: options.alwaysOnTopReply });
  const layout = fakeLayout(options.oneColumn);
  const applied: Theme[] = [];
  const deps = { controller: options.controller ?? service!.api, layout: layout.layout, applyTheme: (theme: Theme) => { applied.push(theme); } };
  const panes = createControllerPanes(host, deps);
  return {
    host, service, layout, applied,
    dispose() {
      panes.dispose();
      host.remove();
    },
  };
}
