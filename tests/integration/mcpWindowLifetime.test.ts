import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from 'node:net';
import { openWindowBridgeForLifetime, windowBridgeDir } from '../../src/main/mcpWindowBridge';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const windowLifetime = () => {
  let closed = false;
  const listeners: (() => void)[] = [];
  return { isClosed: () => closed, onClosed: (listener: () => void) => { listeners.push(listener); }, close: () => { closed = true; for (const listener of listeners) listener(); } };
};

it.each(['before opening', 'during opening'])('releases a bridge when its window closes %s', async timing => {
  const appHome = mkdtempSync(join(tmpdir(), 'ml-')); roots.push(appHome);
  const lifetime = windowLifetime();
  if (timing === 'before opening') lifetime.close();
  const opening = openWindowBridgeForLifetime({ appHome, build: 'test', handle: async () => ({}), lifetime });
  if (timing === 'during opening') lifetime.close();
  expect(await opening).toBeNull();
  expect(readdirSync(windowBridgeDir(appHome))).toEqual([]);
});

it('closes live clients and removes the endpoint while the host process continues', async () => {
  const appHome = mkdtempSync(join(tmpdir(), 'ml-')); roots.push(appHome);
  const lifetime = windowLifetime();
  const bridge = await openWindowBridgeForLifetime({ appHome, build: 'test', handle: async () => ({}), lifetime });
  expect(bridge).not.toBeNull();
  const socket = connect(bridge!.endpoint);
  try {
    await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
    const closed = new Promise<void>(resolve => socket.once('close', () => resolve()));
    lifetime.close();
    await closed;
    await expect.poll(() => readdirSync(windowBridgeDir(appHome))).toEqual([]);
  } finally { socket.destroy(); await bridge!.close(); }
});
