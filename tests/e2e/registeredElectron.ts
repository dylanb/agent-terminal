import { _electron, type ElectronApplication } from '@playwright/test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveAppHome } from '../../src/main/launchRoot';
import { startControllerTransport } from '../../src/main/controllerTransport';
import type { ControllerLoopMessage } from '../../src/shared/ipc';
import { busyExecutableReport } from './busyExecutable';
import { withSetupCheckOff } from './setupCheckEnv';
import { claudeConfigPaths, isSharedClaudeConfig } from '../helpers/fakeClaude';
import { APP_MCP_ACK_TIMEOUT_ENV } from '../../src/shared/mcp';

type Transport = Awaited<ReturnType<typeof startControllerTransport>>;
const controllers = new Map<string, { ready: Promise<Transport>; users: number }>();
const launched = new WeakMap<ElectronApplication, Transport>();
const disposed = new WeakMap<Transport, Promise<void>>();
function disposeOnce(transport: Transport): Promise<void> {
  const done = disposed.get(transport) ?? transport.dispose();
  disposed.set(transport, done);
  return done;
}
/** An MCP call the app acknowledges slowly under load is never reported as "app unreachable" in an e2e: only a launch
 *  that sets `APP_MCP_ACK_TIMEOUT_MS` to a value other than the shell's (the timeout's own tests) gets a reachable one. */
const MCP_ACK_OUT_OF_REACH_MS = String(60 * 60 * 1000);

/** Fails the closing test when it wrote the worker-shared Claude Code config (by `claude mcp` or directly), and
 *  restores what it changed, so the worker's later tests never run its hooks or servers. */
function sharedConfigWriteCheck(env: Record<string, string>): () => void {
  const paths = claudeConfigPaths(env);
  if (!isSharedClaudeConfig(paths.root)) return () => {};
  const read = (file: string) => (existsSync(file) ? readFileSync(file, 'utf8') : null);
  const before = [paths.settings, paths.state].map((file) => [file, read(file)] as const);
  return () => {
    const changed = before.filter(([file, bytes]) => read(file) !== bytes);
    for (const [file, bytes] of changed) {
      if (bytes === null) rmSync(file, { force: true });
      else writeFileSync(file, bytes);
    }
    if (changed.length > 0) throw new Error(`This test wrote the worker's shared Claude Code config (${changed.map(([file]) => file).join(', ')}), now restored; give it its own with seedIsolatedClaudeConfig`);
  };
}

/** The controller the app registered with, as the terminal for `launchDirectory` reports to it. */
export function controllerOf(app: ElectronApplication) {
  const transport = launched.get(app);
  if (!transport) throw new Error('This app was not launched through registeredElectron');
  const terminal = () => transport.terminals().find(item => item.status !== 'disconnected');
  return {
    /** Stops the controller this app registered with, so the app runs on with none connected. */
    disconnect: (): Promise<void> => disposeOnce(transport),
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
    for (const [key, value] of Object.entries({ ...process.env, ...withSetupCheckOff(options.env) })) {
      if (value !== undefined) env[key] = value;
    }
    // A launch that spreads process.env carries the shell's value, which is not the test's own.
    const ownAckTimeout = options.env?.[APP_MCP_ACK_TIMEOUT_ENV];
    if (ownAckTimeout === undefined || ownAckTimeout === process.env[APP_MCP_ACK_TIMEOUT_ENV]) env[APP_MCP_ACK_TIMEOUT_ENV] = MCP_ACK_OUT_OF_REACH_MS;
    const isolatedHome = !env.APP_HOME_DIR && env.HOME === process.env.HOME
      ? mkdtempSync(join(tmpdir(), 'at-launch-')) : undefined;
    if (isolatedHome) env.APP_HOME_DIR = isolatedHome;
    // A launch that chose no Claude Code config of its own never reads or installs into the developer's: neither the
    // one their real HOME implies nor one their shell exported.
    // An empty or unset value falls back to HOME, so it is decided on HOME, not on whether it differs from the shell's.
    const ownClaudeConfig = env.CLAUDE_CONFIG_DIR?.trim() || undefined;
    const inheritedClaudeConfig = ownClaudeConfig === undefined
      ? env.HOME === process.env.HOME
      : ownClaudeConfig === process.env.CLAUDE_CONFIG_DIR?.trim();
    // The root itself is left absent, as on a machine where Claude Code has never written its configuration.
    const isolatedClaudeConfig = inheritedClaudeConfig ? mkdtempSync(join(tmpdir(), 'at-launch-claude-')) : undefined;
    if (isolatedClaudeConfig) env.CLAUDE_CONFIG_DIR = join(isolatedClaudeConfig, 'claude-config');
    const checkSharedConfig = sharedConfigWriteCheck(env);
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
        await disposeOnce(await controller.ready);
      }
      if (isolatedHome) rmSync(isolatedHome, { recursive: true, force: true });
      if (isolatedClaudeConfig) rmSync(isolatedClaudeConfig, { recursive: true, force: true });
    };
    try {
      const transport = await controller.ready;
      const app = await _electron.launch({ ...options, env });
      launched.set(app, transport);
      const close = app.close.bind(app);
      app.close = async () => {
        const errors: unknown[] = [];
        for (const step of [close, release, async () => checkSharedConfig()]) {
          try { await step(); } catch (error) { errors.push(error); }
        }
        if (errors.length === 1) throw errors[0];
        if (errors.length > 1) throw new AggregateError(errors, 'app.close failed in more than one step');
      };
      return app;
    } catch (error) {
      await release();
      if (error instanceof Error && error.message.includes('ETXTBSY')) {
        const report = busyExecutableReport(options.executablePath ?? (createRequire(__filename)('electron') as string));
        console.error(report);
        error.message = `${error.message}\n${report}`;
      }
      throw error;
    }
  },
};
