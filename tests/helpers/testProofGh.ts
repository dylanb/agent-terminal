import { accessSync, constants, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';

export const TEST_PROOF_GH_ORIGIN = 'https://github.com/fixture/project.git';
export const TEST_PROOF_GH_PAGE_SIZE = 30;

export interface StandInPullRequest {
  number: number;
  headRefName: string;
  headRefOid: string;
  isCrossRepository: boolean;
}

export interface StandInComment {
  id: number;
  login: string;
  body: string;
}

export interface StandInStatus {
  sha: string;
  state: string;
  context: string;
  description: string;
}

export interface TestProofGhState {
  loggedIn: boolean;
  login: string;
  pullRequests: StandInPullRequest[];
  comments: Record<string, StandInComment[]>;
  statuses: StandInStatus[];
  failStatusFor: string[];
  failCommentWrite: boolean;
  calls: string[][];
  nextCommentId: number;
}

export interface TestProofGh {
  read(): TestProofGhState;
  set(patch: Partial<TestProofGhState>): void;
}

const STAND_IN = String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const file = path.join(__dirname, 'test-proof-gh.json');
const lock = file + '.lock';
for (;;) {
  try { fs.closeSync(fs.openSync(lock, 'wx')); break; } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
}
let state;
try { state = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { fs.unlinkSync(lock); throw e; }
const args = process.argv.slice(2);
state.calls.push(args);
const REPO = 'fixture/project';
const PAGE = ${TEST_PROOF_GH_PAGE_SIZE};
const DONE = Symbol('done');
const save = () => { fs.writeFileSync(file + '.tmp', JSON.stringify(state)); fs.renameSync(file + '.tmp', file); };
const fail = (code, message) => { save(); process.stderr.write(message + '\n'); process.exitCode = code; throw DONE; };
const unexpected = () => fail(97, 'Unexpected GitHub operation: ' + JSON.stringify(args));
const out = (value) => { save(); process.stdout.write(typeof value === 'string' ? value : JSON.stringify(value)); throw DONE; };

function options(list, withValue, bare) {
  const parsed = { positional: [], fields: {}, flags: new Set(), values: {} };
  for (let i = 0; i < list.length; i++) {
    const arg = list[i];
    if (arg === '-f' || arg === '--raw-field') {
      const pair = list[++i] ?? '';
      const eq = pair.indexOf('=');
      if (eq < 1) unexpected();
      parsed.fields[pair.slice(0, eq)] = pair.slice(eq + 1);
    } else if (withValue.includes(arg)) {
      if (i + 1 >= list.length) unexpected();
      parsed.values[arg] = list[++i];
    } else if (bare.includes(arg)) {
      parsed.flags.add(arg);
    } else if (arg.startsWith('-')) {
      unexpected();
    } else {
      parsed.positional.push(arg);
    }
  }
  return parsed;
}

function pageSize(query) {
  const n = Number(query.get('per_page') ?? PAGE);
  return Number.isInteger(n) && n >= 1 ? Math.min(n, 100) : PAGE;
}

function pageOf(items, query) {
  const perPage = pageSize(query);
  const page = Number(query.get('page') ?? 1);
  return items.slice((page - 1) * perPage, page * perPage);
}

function pages(items, query) {
  const perPage = pageSize(query);
  const all = [];
  for (let i = 0; i === 0 || i < items.length; i += perPage) all.push(items.slice(i, i + perPage));
  return all;
}

const asComment = (c) => ({ id: c.id, user: { login: c.login }, body: c.body });

try {

if (args[0] === 'auth' && args[1] === 'status' && args.length === 2) {
  if (!state.loggedIn) fail(1, 'You are not logged into any GitHub hosts. To log in, run: gh auth login');
  out('github.com\n  Logged in to github.com account ' + state.login + '\n');
}
if (!state.loggedIn) fail(4, 'To get started with GitHub CLI, please run:  gh auth login');

if (args[0] === 'repo' && args[1] === 'view' && args[2] === 'github.com/' + REPO) {
  out({ nameWithOwner: REPO, url: 'https://github.com/' + REPO, defaultBranchRef: { name: 'main' } });
}

if (args[0] === 'pr' && args[1] === 'list') {
  const o = options(args.slice(2), ['--repo', '--head', '--state', '--limit', '--json'], []);
  if (o.positional.length || o.values['--repo'] !== 'github.com/' + REPO || o.values['--state'] !== 'open' || !o.values['--head'] || !o.values['--json']) unexpected();
  const fields = o.values['--json'].split(',');
  const limit = Number(o.values['--limit'] ?? 30);
  const listed = state.pullRequests
    .filter((pr) => pr.headRefName === o.values['--head'])
    .slice(0, limit)
    .map((pr) => {
      const full = { ...pr, url: 'https://github.com/' + REPO + '/pull/' + pr.number };
      const projected = {};
      for (const f of fields) {
        if (!(f in full)) unexpected();
        projected[f] = full[f];
      }
      return projected;
    });
  out(listed);
}

if (args[0] === 'api') {
  const o = options(args.slice(1), ['--method', '-X', '--hostname'], ['--paginate', '--slurp']);
  if (o.positional.length !== 1) unexpected();
  if (o.values['--hostname'] !== undefined && o.values['--hostname'] !== 'github.com') unexpected();
  const method = (o.values['--method'] ?? o.values['-X'] ?? (Object.keys(o.fields).length ? 'POST' : 'GET')).toUpperCase();
  const url = new URL(o.positional[0].replace(/^\//, ''), 'https://api.invalid/');
  const route = url.pathname.slice(1);
  let m;
  if (route === 'user' && method === 'GET') out({ login: state.login });
  if ((m = /^repos\/fixture\/project\/statuses\/([0-9a-f]{40})$/.exec(route)) && method === 'POST') {
    const { state: s, context, description } = o.fields;
    if (typeof s !== 'string' || typeof context !== 'string' || typeof description !== 'string') unexpected();
    if (description.length > 140) fail(1, 'HTTP 422: description is too long (maximum is 140 characters)');
    if (state.failStatusFor.includes(context)) fail(1, 'HTTP 500: status rejected');
    state.statuses.push({ sha: m[1], state: s, context, description });
    out({ state: s, context, description });
  }
  if ((m = /^repos\/fixture\/project\/issues\/(\d+)\/comments$/.exec(route))) {
    const list = state.comments[m[1]] ?? [];
    if (method === 'GET') {
      if (!o.flags.has('--paginate')) out(pageOf(list.map(asComment), url.searchParams));
      const all = pages(list.map(asComment), url.searchParams);
      out(o.flags.has('--slurp') ? JSON.stringify(all) : all.map((p) => JSON.stringify(p)).join(''));
    }
    if (method === 'POST') {
      if (typeof o.fields.body !== 'string') unexpected();
      if (state.failCommentWrite) fail(1, 'HTTP 500: comment rejected');
      const comment = { id: state.nextCommentId++, login: state.login, body: o.fields.body };
      state.comments[m[1]] = [...list, comment];
      out(asComment(comment));
    }
  }
  if ((m = /^repos\/fixture\/project\/issues\/comments\/(\d+)$/.exec(route)) && method === 'PATCH') {
    if (typeof o.fields.body !== 'string') unexpected();
    if (state.failCommentWrite) fail(1, 'HTTP 500: comment rejected');
    const id = Number(m[1]);
    const owner = Object.values(state.comments).flat().find((c) => c.id === id);
    if (!owner) fail(1, 'HTTP 404: Not Found');
    if (owner.login !== state.login) fail(1, 'HTTP 403: Resource not accessible');
    owner.body = o.fields.body;
    out(asComment(owner));
  }
}
unexpected();
} catch (e) {
  if (e !== DONE) throw e;
} finally {
  fs.unlinkSync(lock);
}
`;

/**
 * Installs a stand-in `gh` at `bin/gh` serving GitHub repository `fixture/project` (origin
 * `TEST_PROOF_GH_ORIGIN`). It answers only these operations, and exits 97 naming any other call:
 *
 * - `gh auth status` — exit 0 when `loggedIn`, else exit 1; every other call also fails while logged out.
 * - `gh repo view github.com/fixture/project --json …` — the shape `resolveGitHubRepository` reads.
 * - `gh pr list --repo github.com/fixture/project --head <branch> --state open [--limit n] --json <fields>` —
 *   `pullRequests` on that branch, projected onto the requested fields (`url` is derived from `number`).
 * - `gh api user` — `{ login }`.
 * - `gh api repos/fixture/project/statuses/<sha> -f state=… -f context=… -f description=…` — records a status;
 *   fails for a context in `failStatusFor`, and for a description over GitHub's 140-character limit.
 * - `gh api repos/fixture/project/issues/<n>/comments` — lists `{ id, user: { login }, body }`, one page of
 *   `TEST_PROOF_GH_PAGE_SIZE` (or `?per_page=`, capped at GitHub's 100) unless `--paginate`; `--paginate` prints each page's array
 *   back to back as real `gh` does, and `--paginate --slurp` prints one array of pages. `--jq` is not modelled.
 * - The same path with `-f body=…` — creates a comment authored by `login`.
 * - `gh api -X PATCH repos/fixture/project/issues/comments/<id> -f body=…` — edits it, refused for another
 *   login's comment. Both writes fail while `failCommentWrite` is set.
 *
 * Fields are raw strings only (`-f`/`--raw-field`); `-F`/`--field`, which `gh` type-converts and reads `@file`
 * from, exits 97. `--hostname github.com` is accepted on `gh api`. Every argv is appended to `calls`. Concurrent
 * calls are serialized by a lock file beside the state, so parallel publishes record every write.
 */
export function installTestProofGh(bin: string, initial: Partial<TestProofGhState> = {}): TestProofGh {
  mkdirSync(bin, { recursive: true });
  const stateFile = join(bin, 'test-proof-gh.json');
  const read = (): TestProofGhState => JSON.parse(readFileSync(stateFile, 'utf8')) as TestProofGhState;
  const write = (state: TestProofGhState) => writeFileSync(stateFile, JSON.stringify(state));
  write({
    loggedIn: true,
    login: 'proof-author',
    pullRequests: [],
    comments: {},
    statuses: [],
    failStatusFor: [],
    failCommentWrite: false,
    calls: [],
    nextCommentId: 9001,
    ...initial,
  });
  writeFileSync(join(bin, 'gh'), STAND_IN, { mode: 0o755 });
  return { read, set: (patch) => write({ ...read(), ...patch }) };
}

/**
 * Fills `dir` with links to only the named tools, resolved from the current `PATH`, and returns that dir as a
 * `PATH` value. Nothing else resolves through it — in particular no developer `gh`, so an "absent `gh`" case can
 * never run a real one or reach the network.
 */
export function hermeticPath(dir: string, tools: readonly string[]): string {
  mkdirSync(dir, { recursive: true });
  for (const tool of tools) symlinkSync(tool === 'node' ? process.execPath : resolveOnPath(tool), join(dir, tool));
  return dir;
}

function resolveOnPath(tool: string): string {
  for (const entry of (process.env.PATH ?? '').split(delimiter)) {
    if (!entry || !isAbsolute(entry)) continue;
    const candidate = join(entry, tool);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  throw new Error(`hermeticPath: no executable ${tool} on PATH`);
}
