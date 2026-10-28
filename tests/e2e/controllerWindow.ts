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

/** The controller window's `getNormalBounds()` once the window manager has applied the last move or resize: Electron's
 *  window bounds equal the geometry the X server reports for the window. */
export async function settledNormalBounds(app: ElectronApplication, display: string | undefined): Promise<WindowBounds> {
  if (!display) throw new Error('settledNormalBounds needs the X display of createControllerDesktopHarness');
  const read = () => app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    return {
      xid: window.getNativeWindowHandle().readUInt32LE(0), bounds: window.getBounds(), normal: window.getNormalBounds(),
      enlarged: window.isMaximized() || window.isFullScreen(),
    };
  });
  if ((await read()).enlarged) throw new Error('settledNormalBounds reads a window that is neither maximized nor full screen');
  let settled: WindowBounds | undefined;
  await expect.poll(async () => {
    const { xid, bounds, normal } = await read();
    const x = await xWindowGeometry(display, xid);
    settled = normal;
    return [bounds.x, bounds.y, bounds.width, bounds.height].join() === [x.x, x.y, x.width, x.height].join();
  }).toBe(true);
  return settled!;
}
