import { expect, type Page } from '@playwright/test';
import type { ControllerTerminal } from '../../src/shared/ipc';

export const controllerSnapshot = (page: Page): Promise<ControllerTerminal[]> => page.evaluate(() => new Promise(resolve => {
  const stop = window.controller.subscribeTerminals(items => { stop(); resolve(items); });
}));

export const connectedTerminals = async (page: Page, directory: string) =>
  (await controllerSnapshot(page)).filter(item => item.launchDirectory === directory && item.status !== 'disconnected');

export const waitForConnections = (page: Page, directory: string, count: number) =>
  expect.poll(() => connectedTerminals(page, directory).then(items => items.length), { timeout: 10_000 }).toBe(count);
