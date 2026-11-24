
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { FakeClaudeRecord, McpCallResult } from './fakeClaude';

const FAKE_CLAUDE = resolve(__dirname, 'fakeClaude.ts');

export interface SeededFakeClaude {
  command: string;
  logFile: string;
}

export function seedFakeClaude(binDir: string, opts: { agent?: string; hold?: string } = {}): SeededFakeClaude {
  const command = join(binDir, 'claude');
  const logFile = join(binDir, 'fake-claude.log');
  const node = /\s/.test(process.execPath) ? '/usr/bin/env node' : process.execPath;
  const defaults: Record<string, string> = { FAKE_CLAUDE_LOG: logFile, ...(opts.agent ? { FAKE_CLAUDE_AGENT: opts.agent } : {}), ...(opts.hold ? { FAKE_CLAUDE_HOLD: opts.hold } : {}) };
  writeFileSync(
    command,
    `#!${node}\n` +
      `for (const [k, v] of Object.entries(${JSON.stringify(defaults)})) process.env[k] ??= v;\n` +
      'process.removeAllListeners("warning");\n' +
      `import(${JSON.stringify(FAKE_CLAUDE)}).then((m) => m.runFakeClaude(process.argv.slice(2)), (e) => { console.error(e); process.exit(70); });\n`,
    { mode: 0o755 },
  );
  return { command, logFile };
}

export function readFakeClaudeLog(logFile: string): FakeClaudeRecord[] {
  if (!existsSync(logFile)) return [];
  return readFileSync(logFile, 'utf8')
    .split('\n')
    .slice(0, -1)
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as FakeClaudeRecord);
}

export function fakeClaudeCalls(logFile: string, tool?: string): Extract<FakeClaudeRecord, { event: 'call' }>[] {
  return readFakeClaudeLog(logFile).filter(
    (r): r is Extract<FakeClaudeRecord, { event: 'call' }> => r.event === 'call' && (tool === undefined || r.tool === tool),
  );
}

export const resultText = (result: McpCallResult | undefined): string =>
  (result?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n');

export interface FakeClaudeRun {
  exit: number | null;
  stdout: string;
  stderr: string;
}

export function runFakeClaude(command: string, args: string[], opts: { env: NodeJS.ProcessEnv; cwd: string; input?: string; signal?: AbortSignal }): Promise<FakeClaudeRun> {
  return new Promise((done, fail) => {
    const child = spawn(command, args, { cwd: opts.cwd, env: opts.env, stdio: ['pipe', 'pipe', 'pipe'], signal: opts.signal, killSignal: 'SIGTERM' });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
    child.on('error', fail);
    child.on('close', (exit) => done({ exit, stdout, stderr }));
    child.stdin.on('error', () => {});
    child.stdin.end(opts.input ?? '');
  });
}
