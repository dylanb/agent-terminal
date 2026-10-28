import { expect, type ElectronApplication, type Page } from '@playwright/test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { alwaysOnTopLocator } from '../helpers/controllerCards';

const exec = promisify(execFile);

export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

const controllerWindow = (app: ElectronApplication, read: 'isMinimized' | 'isMaximized' | 'isFullScreen' | 'isAlwaysOnTop') =>
  app.evaluate(({ BrowserWindow }, read) => BrowserWindow.getAllWindows()[0][read](), read);

export const isMinimized = (app: ElectronApplication) => controllerWindow(app, 'isMinimized');
export const isMaximized = (app: ElectronApplication) => controllerWindow(app, 'isMaximized');
export const isFullScreen = (app: ElectronApplication) => controllerWindow(app, 'isFullScreen');
export const isAlwaysOnTop = (app: ElectronApplication) => controllerWindow(app, 'isAlwaysOnTop');
export const normalBounds = (app: ElectronApplication): Promise<WindowBounds> =>
  app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getNormalBounds());

/** Closes the controller window the way the operator does and resolves once it is minimized, so no later step can
 *  act on a window that is still open. */
export async function closeControllerWindow(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await expect.poll(() => isMinimized(app)).toBe(true);
}

/** Resolves once the header switch and the window both show always-on-top as `on`, so no toggle, close or Quit after
 *  it can fire before the last toggle has taken effect. */
export async function waitForAlwaysOnTop({ app, page }: { app: ElectronApplication; page: Page }, on: boolean): Promise<void> {
  await expect(alwaysOnTopLocator(page)).toHaveAttribute('aria-checked', String(on));
  await expect.poll(() => isAlwaysOnTop(app)).toBe(on);
}

async function xWindowGeometry(display: string, xid: number): Promise<WindowBounds> {
  const { stdout } = await exec('xwininfo', ['-id', String(xid)], { env: { ...process.env, DISPLAY: display } });
  const field = (label: string): number => {
    const match = new RegExp(`^\\s*${label}:\\s*(-?\\d+)\\s*$`, 'm').exec(stdout);
    if (!match) throw new Error(`xwininfo reported no ${label} for window ${xid}`);
    return Number(match[1]);
  };
  return { x: field('Absolute upper-left X'), y: field('Absolute upper-left Y'), width: field('Width'), height: field('Height') };
}

/** Moves and resizes the controller window and resolves with its normal bounds once the window manager has applied
 *  the whole change: Electron and the X server can agree on a geometry with only the resize applied. */
export async function moveAndResize(app: ElectronApplication, display: string | undefined, bounds: WindowBounds): Promise<WindowBounds> {
  await app.evaluate(({ BrowserWindow }, bounds) => BrowserWindow.getAllWindows()[0].setBounds(bounds), bounds);
  await shownOnDesktopAt(app, display, bounds);
  return normalBounds(app);
}

/** Resolves once the X server reports the controller window unmapped: a window manager that animates minimizing has
 *  finished moving the frame by then, so every move it reported has reached the window. */
export async function minimizedOnDesktop(app: ElectronApplication, display: string | undefined): Promise<void> {
  if (!display) throw new Error('minimizedOnDesktop needs the X display of createControllerDesktopHarness');
  const xid = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getNativeWindowHandle().readUInt32LE(0));
  await expect.poll(async () => {
    const { stdout } = await exec('xwininfo', ['-id', String(xid)], { env: { ...process.env, DISPLAY: display } });
    return /^\s*Map State:\s*(\S+)/m.exec(stdout)?.[1];
  }).toBe('IsUnMapped');
}

/** Resolves once the X server shows the controller window mapped at `bounds` and Electron reports the same bounds: a
 *  window manager that animates restoring moves the mapped frame along the way, so this holds only once it has ended. */
export async function shownOnDesktopAt(app: ElectronApplication, display: string | undefined, bounds: WindowBounds): Promise<void> {
  if (!display) throw new Error('shownOnDesktopAt needs the X display of createControllerDesktopHarness');
  const xid = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getNativeWindowHandle().readUInt32LE(0));
  const shown = (b: WindowBounds) => [b.x, b.y, b.width, b.height].join();
  await expect.poll(async () => {
    const { stdout } = await exec('xwininfo', ['-id', String(xid)], { env: { ...process.env, DISPLAY: display } });
    const electron = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds());
    return { mapState: /^\s*Map State:\s*(\S+)/m.exec(stdout)?.[1], x: shown(await xWindowGeometry(display, xid)), electron: shown(electron) };
  }).toEqual({ mapState: 'IsViewable', x: shown(bounds), electron: shown(bounds) });
}
