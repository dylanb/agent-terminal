// Long-running processes a seeded fake agent starts on request, shaped like a harness's commands and helpers: a
// line `fake-spawn <group> <name>` typed to the agent starts a copy of `sleep` named `<name>`, so the OS reports
// `<name>` (cut to its executable-name limit) as its program name. `own` puts it in a new process group of its
// own, as Claude Code and Codex run a command (and as Codex runs `codex-code-mode-host`); `agent` leaves it in
// the agent's own group, as Claude Code runs `caffeinate`.

import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { shellQuote } from '../../src/shared/shellQuote';
import { isErrno } from '../../src/main/errno';
import { WINDOW_TIMEOUT_MS } from '../helpers/e2eBudget';

export type FakeProcessGroup = 'own' | 'agent';

const NAME = /^[a-z][a-z0-9-]{0,39}$/;
// A last resort for a process every cleanup path missed; the agent's exit and `stopAllFakeProcesses` end it first.
const LIFETIME_CAP_S = 300;
const POLL_MS = 50;

const processDir = (binDir: string): string => join(binDir, 'fake-processes');
const pidFile = (binDir: string, name: string): string => join(processDir(binDir), `${name}.pid`);

function checkedName(name: string): string {
  if (!NAME.test(name)) throw new RangeError(`fake process name must match ${NAME}; got ${JSON.stringify(name)}`);
  return name;
}

/** The shell source a fake agent script includes: `fake_spawn <group> <name>`, and an EXIT trap that kills every
 *  process it started when the agent exits on a signal it can trap. `disown` keeps bash's job notices off the
 *  screen. The trap splits each record without `read`, because it can run inside the agent's `IFS= read`. */
export function fakeSpawnShell(binDir: string): string {
  const dir = shellQuote(processDir(binDir));
  return (
    `fake_spawn() { d=${dir}; mkdir -p "$d/bin"; [ -x "$d/bin/$2" ] || cp "$(command -v sleep)" "$d/bin/$2"; ` +
    `if [ "$1" = own ]; then set -m; "$d/bin/$2" ${LIFETIME_CAP_S} </dev/null >/dev/null 2>&1 & p=$!; disown "$p"; set +m; ` +
    `else "$d/bin/$2" ${LIFETIME_CAP_S} </dev/null >/dev/null 2>&1 & p=$!; disown "$p"; fi; ` +
    `printf '%s %s\\n' "$p" "$1" > "$d/$2.pid.tmp" && mv "$d/$2.pid.tmp" "$d/$2.pid"; }\n` +
    `fake_reap() { for f in ${dir}/*.pid; do [ -e "$f" ] || continue; r=$(cat "$f"); p=\${r%% *}; g=\${r#* }; ` +
    `if [ "$g" = own ]; then kill -KILL -- "-$p" 2>/dev/null; else kill -KILL "$p" 2>/dev/null; fi; rm -f "$f"; done; }\n` +
    'trap fake_reap EXIT\n'
  );
}

/** The `case` arm that answers a `fake-spawn` line; `fakeSpawnShell` must be in the same script. */
export const FAKE_SPAWN_ARM = '    "fake-spawn own "*|"fake-spawn agent "*) fake_spawn ${line#fake-spawn } ;;';

/** The line to type to a running fake agent to start `name` in `group`. */
export function fakeSpawnLine(name: string, group: FakeProcessGroup): string {
  return `fake-spawn ${group} ${checkedName(name)}`;
}

interface Recorded {
  readonly pid: number;
  readonly group: FakeProcessGroup;
}

function recorded(binDir: string, name: string): Recorded | null {
  const file = pidFile(binDir, checkedName(name));
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    if (isErrno(e, 'ENOENT')) return null;
    throw e;
  }
  const [pid, group] = text.trim().split(' ');
  if (!/^\d+$/.test(pid) || (group !== 'own' && group !== 'agent')) throw new Error(`malformed fake process record ${file}`);
  return { pid: Number(pid), group };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    if (isErrno(e, 'ESRCH')) return false;
    throw e;
  }
}

async function until(what: string, done: () => boolean): Promise<void> {
  const deadline = Date.now() + WINDOW_TIMEOUT_MS;
  while (!done()) {
    if (Date.now() >= deadline) throw new Error(`fake process: ${what}`);
    await delay(POLL_MS);
  }
}

/** The pid of `name` once the agent has started it. */
export async function fakeProcessPid(binDir: string, name: string): Promise<number> {
  let found: Recorded | null = null;
  await until(`${name} was never started`, () => (found = recorded(binDir, name)) !== null);
  return found!.pid;
}

/** Whether `name` was started and is still in the process table. */
export function fakeProcessRunning(binDir: string, name: string): boolean {
  const r = recorded(binDir, name);
  return r !== null && alive(r.pid);
}

function kill(r: Recorded): void {
  try {
    process.kill(r.group === 'own' ? -r.pid : r.pid, 'SIGKILL');
  } catch (e) {
    if (!isErrno(e, 'ESRCH')) throw e;
  }
}

/** Kills `name` (its whole group when it has one of its own) and resolves once the agent has reaped it, so a
 *  process table read afterwards no longer lists it. Its record goes with it, so no later cleanup signals a pid
 *  the OS may have reused, and the name can be started again. */
export async function stopFakeProcess(binDir: string, name: string): Promise<void> {
  const r = recorded(binDir, name);
  if (!r) throw new Error(`fake process ${name} was never started`);
  kill(r);
  await until(`${name} (pid ${r.pid}) is still in the process table after SIGKILL`, () => !alive(r.pid));
  rmSync(pidFile(binDir, name), { force: true });
}

/** Kills every process any fake agent seeded into `binDir` started and verifies each is gone; for a test's
 *  `finally`, before the app closes, since a fake process left running can hold the app's close. */
export async function stopAllFakeProcesses(binDir: string): Promise<void> {
  const dir = processDir(binDir);
  if (!existsSync(dir)) return;
  const names = readdirSync(dir).filter((f) => f.endsWith('.pid')).map((f) => f.slice(0, -'.pid'.length));
  const left = names.map((n) => recorded(binDir, n)).filter((r): r is Recorded => r !== null && alive(r.pid));
  for (const r of left) kill(r);
  await until(`pids ${left.map((r) => r.pid).join(', ')} survived SIGKILL`, () => left.every((r) => !alive(r.pid)));
  for (const n of names) rmSync(pidFile(binDir, n), { force: true });
}
