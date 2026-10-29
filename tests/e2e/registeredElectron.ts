import { _electron, type ElectronApplication } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveAppHome } from '../../src/main/launchRoot';
import { startControllerTransport } from '../../src/main/controllerTransport';
import type { ControllerLoopMessage } from '../../src/shared/ipc';

type Transport = Awaited<ReturnType<typeof startControllerTransport>>;
const controllers = new Map<string, { ready: Promise<Transport>; users: number }>();
const launched = new WeakMap<ElectronApplication, Transport>();

/** The controller the app registered with, as the terminal for `launchDirectory` reports to it. */
export function controllerOf(app: ElectronApplication) {
  const transport = launched.get(app);
  if (!transport) throw new Error('This app was not launched through registeredElectron');
  const terminal = () => transport.terminals().find(item => item.status !== 'disconnected');
  return {
    loopMessage: (): ControllerLoopMessage | null | undefined => terminal()?.work?.loopMessage,
    dismissLoopMessage(messageId: string) {
      const id = terminal()?.id;
      if (id) transport.dismissLoopMessage(id, messageId);
    },
    /** Every distinct loop message the terminal reports from now on, in order. */
    recordLoopMessages(): () => ControllerLoopMessage[] {
      const seen: ControllerLoopMessage[] = [];
      transport.subscribeTerminals(terminals => {
        for (const item of terminals) {
          const message = item.work?.loopMessage;
          if (message && !seen.some(known => known.id === message.id)) seen.push(message);
        }
      });
      return () => [...seen];
    },
  };
}

export const electron = {
  async launch(options: NonNullable<Parameters<typeof _electron.launch>[0]>) {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries({ ...process.env, ...options.env })) {
      if (value !== undefined) env[key] = value;
    }
    const isolatedHome = !env.APP_HOME_DIR && env.HOME === process.env.HOME
      ? mkdtempSync(join(tmpdir(), 'at-launch-')) : undefined;
    if (isolatedHome) env.APP_HOME_DIR = isolatedHome;
    const home = resolveAppHome(env, homedir());
    let controller = controllers.get(home);
    if (!controller) {
      controller = { ready: startControllerTransport(home), users: 0 };
      controllers.set(home, controller);
    }
    controller.users++;
    let released = false;
    const release = async () => {
      if (released) return;
      released = true;
      if (--controller.users === 0) {
        controllers.delete(home);
        await (await controller.ready).dispose();
      }
      if (isolatedHome) rmSync(isolatedHome, { recursive: true, force: true });
    };
    try {
      const transport = await controller.ready;
      const app = await _electron.launch({ ...options, env });
      launched.set(app, transport);
      const close = app.close.bind(app);
      app.close = async () => { try { await close(); } finally { await release(); } };
      return app;
    } catch (error) {
      await release();
      throw error;
    }
  },
};
