import { afterEach, expect, it } from 'vitest';
import { execFile, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import type WebSocket from 'ws';
import { readProcessTable } from '../../src/main/waitingLookup';
import { waitingInTable } from '../../src/main/waitingRule';
import { registerControllerTerminal } from '../../src/main/controllerClient';
import { resolveControllerEndpoint } from '../../src/main/controllerEndpoint';
import { CONTROLLER_PROTOCOL_MAJOR, CONTROLLER_WAITING_MINOR, encodeControllerMessage } from '../../src/shared/controllerProtocol';
import { shellQuote } from '../../src/shared/shellQuote';
import { createWebSocketTestServer } from '../helpers/controllerWebSocket';
import { workStatus } from '../helpers/controllerStatusFixture';

const exec = promisify(execFile);
const SECRET = 'abc123';
const POLL_MS = 200;
const QUALIFIED_S = 3;

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function killGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try { process.kill(-pid, 'SIGKILL'); } catch { }
}

async function agentWithSecretCommand(): Promise<{ shellPid: number; commandPid: number; program: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'waiting-real-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const agent = join(dir, 'agent.js');
  const report = join(dir, 'agent.json');
  writeFileSync(agent, [
    "const { spawn } = require('node:child_process');",
    `const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', '--', '--token=${SECRET}'], { detached: true, stdio: 'ignore' });`,
    `require('node:fs').writeFileSync(${JSON.stringify(report)}, JSON.stringify({ shellPid: process.ppid, commandPid: c.pid }));`,
    'setInterval(() => {}, 1000);',
  ].join('\n'));
  const shell = `node ${shellQuote(agent)}; true`;
  const args = process.platform === 'darwin'
    ? ['-q', '/dev/null', 'bash', '--norc', '--noprofile', '-i', '-c', shell]
    : ['-q', '-e', '-c', `bash --norc --noprofile -i -c ${shellQuote(shell)}`, '/dev/null'];
  const terminal = spawn('script', args, { detached: true, stdio: 'ignore' });
  let started: { shellPid: number; commandPid: number } | undefined;
  cleanups.push(() => { killGroup(started?.commandPid); killGroup(terminal.pid); });
  for (;;) {
    try { started = JSON.parse(readFileSync(report, 'utf8')); break; } catch { await delay(POLL_MS); }
  }
  const elapsed = async (): Promise<number> => {
    const { stdout } = await exec('ps', ['-o', 'etime=', '-p', String(started!.commandPid)]);
    return stdout.trim().split(/[-:]/).map(Number).reduce((total, part) => total * 60 + part, 0);
  };
  while (await elapsed() < QUALIFIED_S) await delay(POLL_MS);
  const { stdout } = await exec('ps', ['-o', 'ucomm=', '-p', String(started!.commandPid)]);
  return { ...started!, program: stdout.trim() };
}

async function waitingMinorController(home: string): Promise<{ frames: string[] }> {
  const endpoint = resolveControllerEndpoint(home);
  mkdirSync(dirname(endpoint), { recursive: true, mode: 0o700 });
  const peers = new Set<WebSocket>();
  const frames: string[] = [];
  const server = createWebSocketTestServer(peer => {
    peers.add(peer);
    peer.on('error', () => {});
    peer.once('message', () => {
      peer.on('message', frame => frames.push(frame.toString()));
      peer.send(encodeControllerMessage({ version: CONTROLLER_PROTOCOL_MAJOR, minor: CONTROLLER_WAITING_MINOR, type: 'registered' }));
    });
  });
  await new Promise<void>(resolve => server.listen(endpoint, resolve));
  cleanups.push(async () => {
    for (const peer of peers) peer.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  return { frames };
}

it('names a real command by its program only, so its arguments reach neither the Waiting value nor the controller', async () => {
  const { shellPid, program } = await agentWithSecretCommand();
  const table = await readProcessTable({ signal: new AbortController().signal });
  const platform = process.platform === 'darwin' ? 'darwin' : 'linux';
  const waiting = waitingInTable(table, { shellPid, platform, helpers: [] });
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'waiting-wire-')));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const controller = await waitingMinorController(home);
  cleanups.push(registerControllerTerminal(home, { launchDirectory: '/work', repositoryRoot: null }, () => 'activated', () => {},
    listener => { listener(workStatus(waiting ? { activity: 'waiting', waiting } : { activity: 'quiet' })); return () => {}; }));
  while (controller.frames.length === 0) await delay(POLL_MS);
  expect({ waiting, secretInFrame: controller.frames.some(frame => frame.includes(SECRET)), waitingFrame: controller.frames.some(frame => frame.includes('"waiting"')) })
    .toEqual({ waiting: { program, others: 0 }, secretInFrame: false, waitingFrame: true });
}, 60_000);
