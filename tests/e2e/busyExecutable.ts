import { readdirSync, readFileSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';

// ETXTBSY (execve(2)) means some process holds the executable open for writing. Linux only: reads /proc.
const O_ACCMODE = 0o3;

function read(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function holdersOf(target: string): string[] {
  const holders: string[] = [];
  for (const pid of readdirSync('/proc').filter((d) => /^\d+$/.test(d))) {
    let fds: string[];
    try {
      fds = readdirSync(join('/proc', pid, 'fd'));
    } catch {
      continue;
    }
    for (const fd of fds) {
      let link: string;
      try {
        link = readlinkSync(join('/proc', pid, 'fd', fd));
      } catch {
        continue;
      }
      if (link !== target && link !== `${target} (deleted)`) continue;
      const flags = Number.parseInt(/^flags:\s*(\d+)/m.exec(read(join('/proc', pid, 'fdinfo', fd)) ?? '')?.[1] ?? '0', 8);
      const ppid = /^PPid:\s*(\d+)/m.exec(read(join('/proc', pid, 'status')) ?? '')?.[1] ?? '?';
      const cmd = (read(join('/proc', pid, 'cmdline')) ?? '').split('\0').join(' ').trim().slice(0, 300);
      holders.push(`pid=${pid} ppid=${ppid} fd=${fd} ${(flags & O_ACCMODE) === 0 ? 'read-only' : 'WRITE'} flags=0${flags.toString(8)} cmd=${cmd}`);
    }
  }
  return holders;
}

/** A report of who holds `executable` open, for a launch that failed with ETXTBSY. Never throws. */
export function busyExecutableReport(executable: string): string {
  try {
    if (process.platform !== 'linux') return `busy-executable report: /proc is unavailable on ${process.platform}`;
    const target = realpathSync(executable);
    const st = statSync(target);
    const holders = holdersOf(target);
    return [
      `busy-executable report for ${target} at ${new Date().toISOString()} (mtime ${st.mtime.toISOString()}, ctime ${st.ctime.toISOString()}, links ${st.nlink}):`,
      ...(holders.length === 0 ? ['  no process holds it open now (the writer closed it before this scan)'] : holders.map((h) => `  ${h}`)),
    ].join('\n');
  } catch (e) {
    return `busy-executable report failed: ${e instanceof Error ? e.message : String(e)}`;
  }
}
