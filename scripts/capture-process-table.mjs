#!/usr/bin/env node
// Captures the process table under one terminal's shell, for the Waiting detection tests
// (tests/fixtures/process-tables/, read through tests/helpers/processTable.ts). It records program names only:
// the ps columns below never include a command line, so no argument, token or path reaches a committed fixture.
//
//   node scripts/capture-process-table.mjs <fixture-name> --note "<what is running>" [--shell-pid <pid>] [--delay <s>]
//
// Without --shell-pid it finds the terminal shell above itself: run it as a command of the hosted agent (a Claude
// Code or Codex tool call) and the agent is the shell's foreground. --delay waits first, so the capturing command
// is itself old enough to count. The fixture's `expected` is left for you to write by hand; the loader rejects it
// until you do.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PS_ARGS = ['-A', '-o', 'pid=,ppid=,pgid=,tpgid=,etime=,ucomm='];
const OUT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../tests/fixtures/process-tables');
const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

function usage(why) {
  process.stderr.write(`capture-process-table: ${why}\nusage: node scripts/capture-process-table.mjs <fixture-name> --note "<what is running>" [--shell-pid <pid>] [--delay <s>]\n`);
  process.exit(2);
}

function parseArgs(argv) {
  const [name, ...rest] = argv;
  if (!name || !NAME.test(name)) usage(`fixture name must match ${NAME}`);
  const opts = { name, note: null, shellPid: null, delay: 0 };
  for (let i = 0; i < rest.length; i += 2) {
    const [flag, value] = [rest[i], rest[i + 1]];
    if (value === undefined) usage(`${flag} needs a value`);
    if (flag === '--note') opts.note = value;
    else if (flag === '--shell-pid' && /^\d+$/.test(value)) opts.shellPid = Number(value);
    else if (flag === '--delay' && /^\d+$/.test(value)) opts.delay = Number(value);
    else usage(`unknown or malformed option ${flag} ${value}`);
  }
  if (!opts.note || opts.note.trim() === '') usage('--note must say what is running');
  return opts;
}

function readTable() {
  const stdout = execFileSync('ps', PS_ARGS, { encoding: 'utf8', timeout: 5000 });
  return stdout.split('\n').filter((line) => line.trim() !== '').map((line) => {
    const [pid, ppid, pgid, tpgid] = line.trim().split(/\s+/).map(Number);
    return { line, pid, ppid, pgid, tpgid };
  });
}

/** The nearest ancestor that is a group leader whose terminal foreground is the group of its child on the path to
 *  this process: the terminal's shell running the agent. */
function findShell(rows) {
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  let child = byPid.get(process.pid);
  for (let up = child && byPid.get(child.ppid); up && up.pid > 1; child = up, up = byPid.get(up.ppid)) {
    if (up.pgid === up.pid && up.tpgid > 0 && up.tpgid !== up.pgid && child.pgid === up.tpgid) return up.pid;
  }
  return usage('no terminal shell with an agent in its foreground above this process; pass --shell-pid');
}

function subtree(rows, root) {
  const keep = new Set([root]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const r of rows) {
      if (keep.has(r.pid) || !keep.has(r.ppid)) continue;
      keep.add(r.pid);
      grew = true;
    }
  }
  return rows.filter((r) => keep.has(r.pid)).map((r) => r.line);
}

const opts = parseArgs(process.argv.slice(2));
if (opts.delay > 0) execFileSync('sleep', [String(opts.delay)]);
const rows = readTable();
const shellPid = opts.shellPid ?? findShell(rows);
if (!rows.some((r) => r.pid === shellPid)) usage(`no process ${shellPid}`);
if (process.platform !== 'darwin' && process.platform !== 'linux') usage(`unsupported platform ${process.platform}`);
const file = join(OUT_DIR, `${opts.name}.json`);
if (existsSync(file)) usage(`${file} exists; pick another name or delete it first`);
mkdirSync(OUT_DIR, { recursive: true });
const fixture = {
  platform: process.platform,
  psArgs: PS_ARGS,
  shellPid,
  note: opts.note,
  rows: subtree(rows, shellPid),
  expected: 'write by hand: { "waiting": null } or { "waiting": { "program": "<label>", "others": <n> } }',
};
writeFileSync(file, `${JSON.stringify(fixture, null, 2)}\n`);
process.stdout.write(`${file}: ${fixture.rows.length} processes under shell ${shellPid}\n`);
