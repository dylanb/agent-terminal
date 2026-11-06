import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TOOL_CALL_FIELD, TOOL_CALL_RECORD } from './outwardWrites';

/** GitHub's limit on one PR body or comment, in JavaScript string length. Written here independently of the
 *  app's own constant, so a body the app measured differently from what it sent is refused as GitHub would. */
export const GITHUB_BODY_LIMIT = 65_536;
export const ADOPTION_GH_PAGE_SIZE = 30;
/** Where the stand-in records each contract breach and internal error, one JSON line each, beside its state. */
const BREACHES_FILE = 'adoption-gh.breaches';

export type ViewerPermission = 'ADMIN' | 'MAINTAIN' | 'WRITE' | 'TRIAGE' | 'READ';
/** A repository as GitHub's `nameWithOwner` spells it, matched case-insensitively. */
export type NameWithOwner = `${string}/${string}`;

export interface StandInRepository {
  nameWithOwner: NameWithOwner;
  defaultBranch: string;
  viewerPermission: ViewerPermission;
}

export interface StandInTicket {
  repo: NameWithOwner;
  number: number;
}

export interface StandInPull {
  number: number;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  title: string;
  body: string;
  isDraft: boolean;
  author: string;
  headRefName: string;
  headRefOid: string;
  baseRefName: string;
  /** `<owner>/<name>` of the head repository; null when GitHub reports none (a deleted fork). */
  headRepo: NameWithOwner | null;
  isCrossRepository: boolean;
  closingIssues: StandInTicket[];
}

export interface StandInComment {
  id: number;
  login: string;
  body: string;
}

/** A write the stand-in can be told to fail once, the next time it is attempted. */
export type GhWriteAction = 'pr-create' | 'pr-edit' | 'comment-create' | 'comment-edit';

export interface AdoptionGhState {
  /** The origin repository: every `pr` command and every comment route names it. */
  origin: NameWithOwner;
  /** Repositories `gh repo view` answers for: origin, and any fork's head repository. */
  repositories: StandInRepository[];
  login: string;
  pulls: StandInPull[];
  /** Comments on origin's issue or PR, keyed by its number. */
  comments: Record<string, StandInComment[]>;
  failOnce: GhWriteAction[];
  nextPullNumber: number;
  nextCommentId: number;
}

export interface AdoptionGh {
  read(): AdoptionGhState;
  /** Each call the stand-in refused as a contract breach, or failed on internally, with its argv. */
  breaches(): string[];
  /** Replaces the top-level fields in `patch`; every later `gh` call reads the result. */
  set(patch: Partial<AdoptionGhState>): void;
  /** Applies `edit` to the stored state; every later `gh` call reads the result. */
  update(edit: (state: AdoptionGhState) => void): void;
}

interface StandInConfig {
  logFile: string;
  bareRemote: string;
  realGit: string;
}

const STAND_IN = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'adoption-gh.config.json'), 'utf8'));
const file = path.join(__dirname, 'adoption-gh.json');
const lock = file + '.lock';
const args = process.argv.slice(2);
const breach = (why) => fs.appendFileSync(path.join(__dirname, ${JSON.stringify(BREACHES_FILE)}), JSON.stringify({ why, args }) + '\n');
const internal = (e) => { breach('internal error: ' + (e instanceof Error ? e.stack : String(e))); process.stderr.write('adoption gh stand-in: internal error\n'); process.exit(98); };
// Read before the lock is taken: a caller that never closes stdin, then ends this process, must not leave the lock held.
const STDIN_FLAGS = ['--body-file', '-F', '--input'];
const STDIN = args.some((a, i) => (a === '-' && STDIN_FLAGS.includes(args[i - 1])) || STDIN_FLAGS.some((f) => a === f + '=-'))
  ? fs.readFileSync(0, 'utf8')
  : '';
for (;;) {
  try { fs.closeSync(fs.openSync(lock, 'wx')); break; } catch (e) {
    if (e.code !== 'EEXIST') internal(e);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
}
let state;
try {
  fs.appendFileSync(config.logFile, ${JSON.stringify(TOOL_CALL_RECORD)} + ['gh', ...args].map((a) => a + ${JSON.stringify(TOOL_CALL_FIELD)}).join(''));
  state = JSON.parse(fs.readFileSync(file, 'utf8'));
} catch (e) { fs.unlinkSync(lock); internal(e); }
const HOST = 'github.com';
const LIMIT = ${GITHUB_BODY_LIMIT};
const PAGE = ${ADOPTION_GH_PAGE_SIZE};
const DONE = Symbol('done');
const save = () => { fs.writeFileSync(file + '.tmp', JSON.stringify(state)); fs.renameSync(file + '.tmp', file); };
const fail = (code, message) => { save(); process.stderr.write(message + '\n'); process.exitCode = code; throw DONE; };
const contract = (why) => { breach(why); fail(97, 'adoption gh stand-in: ' + why + ': ' + JSON.stringify(args)); };
const out = (value) => { save(); process.stdout.write((typeof value === 'string' ? value : JSON.stringify(value)) + '\n'); throw DONE; };
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const repoUrl = (nwo) => 'https://' + HOST + '/' + nwo;

const PR_ARGV_BODY = ['--body', '-b'];
const API_ARGV_FIELDS = ['-f', '-F', '--field', '--raw-field'];

function options(list, withValue, bare, forbidden) {
  const parsed = { positional: [], flags: new Set(), values: {} };
  for (let i = 0; i < list.length; i++) {
    const arg = list[i];
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
    const name = eq > 0 ? arg.slice(0, eq) : arg;
    if (forbidden.includes(name)) contract('a body or field must arrive on stdin, never as an argv element');
    if (withValue.includes(name)) {
      if (eq > 0) parsed.values[name] = arg.slice(eq + 1);
      else if (i + 1 < list.length) parsed.values[name] = list[++i];
      else contract('missing value for ' + name);
    } else if (bare.includes(name)) {
      parsed.flags.add(name);
    } else if (arg.startsWith('-')) {
      contract('unmodelled option ' + arg);
    } else {
      parsed.positional.push(arg);
    }
  }
  return parsed;
}

function namedRepo(o) {
  const selector = o.values['--repo'] ?? o.values['-R'];
  if (selector === undefined) contract('every pr command names its repository with --repo ' + HOST + '/<owner>/<name>');
  if (!same(selector, HOST + '/' + state.origin)) contract('--repo names ' + selector + ', not the fixture repository ' + HOST + '/' + state.origin);
}

function stdin(o, flag) {
  if (o.values[flag] !== '-') contract('the body arrives on stdin with ' + flag + ' -');
  return STDIN;
}

function withinLimit(body) {
  if (body.length > LIMIT) fail(1, 'HTTP 422: Validation Failed (body is too long (maximum is ' + LIMIT + ' characters))');
  return body;
}

function failingOnce(action) {
  const at = state.failOnce.indexOf(action);
  if (at < 0) return;
  state.failOnce.splice(at, 1);
  fail(1, 'HTTP 502: injected failure for ' + action);
}

function headRepoOf(pr) {
  if (pr.headRepo === null) return null;
  const [owner, name] = pr.headRepo.split('/');
  return { owner, name };
}

const PULL_FIELDS = {
  number: (pr) => pr.number,
  url: (pr) => repoUrl(state.origin) + '/pull/' + pr.number,
  state: (pr) => pr.state,
  title: (pr) => pr.title,
  body: (pr) => pr.body,
  isDraft: (pr) => pr.isDraft,
  author: (pr) => ({ login: pr.author }),
  headRefName: (pr) => pr.headRefName,
  headRefOid: (pr) => pr.headRefOid,
  baseRefName: (pr) => pr.baseRefName,
  isCrossRepository: (pr) => pr.isCrossRepository,
  headRepository: (pr) => { const h = headRepoOf(pr); return h === null ? null : { name: h.name }; },
  headRepositoryOwner: (pr) => { const h = headRepoOf(pr); return h === null ? null : { login: h.owner }; },
  closingIssuesReferences: (pr) => pr.closingIssues.map((t) => {
    const [owner, name] = t.repo.split('/');
    return { number: t.number, url: repoUrl(t.repo) + '/issues/' + t.number, repository: { name, owner: { login: owner } } };
  }),
};

function project(record, fieldList, table) {
  if (fieldList === undefined) contract('--json names the fields to read');
  const projected = {};
  for (const f of fieldList.split(',')) {
    if (!(f in table)) contract('unmodelled --json field ' + f);
    projected[f] = table[f](record);
  }
  return projected;
}

function remoteBranchOid(branch) {
  try {
    return execFileSync(config.realGit, ['--git-dir', config.bareRemote, 'rev-parse', '--verify', '--quiet', '--end-of-options', 'refs/heads/' + branch], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (e) {
    if (e.status === 1) return null;
    breach('reading the bare remote failed: ' + String(e.stderr || e.message));
    fail(98, 'adoption gh stand-in: reading the bare remote failed');
  }
}

function commentsOn(number) {
  const key = String(number);
  if (!state.comments[key]) state.comments[key] = [];
  return state.comments[key];
}

const asComment = (c) => ({ id: c.id, user: { login: c.login }, body: c.body });

try {

if (args[0] === 'repo' && args[1] === 'view') {
  const o = options(args.slice(2), ['--json'], [], PR_ARGV_BODY);
  if (o.positional.length !== 1) contract('repo view names one ' + HOST + '/<owner>/<name> selector');
  const repo = state.repositories.find((r) => same(o.positional[0], HOST + '/' + r.nameWithOwner));
  if (!repo) contract('repo view names ' + o.positional[0] + ', which is not a fixture repository');
  out(project(repo, o.values['--json'], {
    nameWithOwner: (r) => r.nameWithOwner,
    url: (r) => repoUrl(r.nameWithOwner),
    defaultBranchRef: (r) => ({ name: r.defaultBranch }),
    viewerPermission: (r) => r.viewerPermission,
  }));
}

if (args[0] === 'pr' && args[1] === 'view') {
  const o = options(args.slice(2), ['--repo', '-R', '--json'], [], PR_ARGV_BODY);
  namedRepo(o);
  if (o.positional.length !== 1) contract('pr view names one PR number or branch');
  const selector = o.positional[0];
  const byNumber = /^[1-9][0-9]*$/.test(selector);
  // As gh does for a branch: a PR whose head is that branch, an open one first; same-repository for a bare branch,
  // and from that owner's repository for <owner>:<branch>.
  const colon = selector.indexOf(':');
  const headOwner = colon < 0 ? null : selector.slice(0, colon);
  const headBranch = colon < 0 ? selector : selector.slice(colon + 1);
  const forBranch = state.pulls.filter((p) => p.headRefName === headBranch && (headOwner === null ? !p.isCrossRepository : p.headRepo !== null && same(p.headRepo.split('/')[0], headOwner)));
  const pr = byNumber ? state.pulls.find((p) => p.number === Number(selector)) : (forBranch.find((p) => p.state === 'OPEN') ?? forBranch[forBranch.length - 1]);
  if (!pr) fail(1, byNumber ? 'GraphQL: Could not resolve to a PullRequest with the number of ' + selector + '.' : 'no pull requests found for branch "' + selector + '"');
  out(project(pr, o.values['--json'], PULL_FIELDS));
}

if (args[0] === 'pr' && args[1] === 'list') {
  const o = options(args.slice(2), ['--repo', '-R', '--head', '-H', '--base', '-B', '--state', '-s', '--limit', '-L', '--json'], [], PR_ARGV_BODY);
  namedRepo(o);
  if (o.positional.length) contract('pr list takes no positional argument');
  const head = o.values['--head'] ?? o.values['-H'];
  const base = o.values['--base'] ?? o.values['-B'];
  const wanted = (o.values['--state'] ?? o.values['-s'] ?? 'open').toUpperCase();
  const states = { OPEN: ['OPEN'], CLOSED: ['CLOSED', 'MERGED'], MERGED: ['MERGED'], ALL: ['OPEN', 'CLOSED', 'MERGED'] }[wanted];
  if (!states) contract('unmodelled --state ' + wanted);
  const limit = Number(o.values['--limit'] ?? o.values['-L'] ?? 30);
  const listed = state.pulls
    .filter((p) => states.includes(p.state) && (head === undefined || p.headRefName === head) && (base === undefined || p.baseRefName === base))
    .slice(0, limit)
    .map((p) => project(p, o.values['--json'], PULL_FIELDS));
  out(listed);
}

if (args[0] === 'pr' && args[1] === 'create') {
  const o = options(args.slice(2), ['--repo', '-R', '--base', '-B', '--head', '-H', '--title', '-t', '--body-file', '-F'], ['--draft', '-d'], PR_ARGV_BODY);
  namedRepo(o);
  if (o.positional.length) contract('pr create takes no positional argument');
  const base = o.values['--base'] ?? o.values['-B'];
  const head = o.values['--head'] ?? o.values['-H'];
  const title = o.values['--title'] ?? o.values['-t'];
  if (!base || !head) contract('pr create names --base and --head');
  if (!title || !title.trim()) contract('pr create names a non-empty --title');
  if (o.values['-F'] !== undefined) o.values['--body-file'] = o.values['-F'];
  const body = withinLimit(stdin(o, '--body-file'));
  failingOnce('pr-create');
  const headOid = remoteBranchOid(head);
  if (headOid === null) fail(1, 'pull request create failed: GraphQL: Head sha can\'t be blank, Head ref must be a branch (createPullRequest)');
  if (state.pulls.some((p) => p.state === 'OPEN' && p.headRefName === head && p.baseRefName === base && !p.isCrossRepository)) {
    fail(1, 'a pull request for branch "' + head + '" into branch "' + base + '" already exists');
  }
  const number = state.nextPullNumber++;
  state.pulls.push({ number, state: 'OPEN', title, body, isDraft: o.flags.has('--draft') || o.flags.has('-d'), author: state.login, headRefName: head, headRefOid: headOid, baseRefName: base, headRepo: state.origin, isCrossRepository: false, closingIssues: [] });
  out(repoUrl(state.origin) + '/pull/' + number);
}

if (args[0] === 'pr' && args[1] === 'edit') {
  const o = options(args.slice(2), ['--repo', '-R', '--body-file', '-F'], [], PR_ARGV_BODY);
  namedRepo(o);
  if (o.positional.length !== 1 || !/^[1-9][0-9]*$/.test(o.positional[0])) contract('pr edit names one PR number');
  if (o.values['-F'] !== undefined) o.values['--body-file'] = o.values['-F'];
  const body = withinLimit(stdin(o, '--body-file'));
  failingOnce('pr-edit');
  const pr = state.pulls.find((p) => p.number === Number(o.positional[0]));
  if (!pr) fail(1, 'GraphQL: Could not resolve to a PullRequest with the number of ' + o.positional[0] + '.');
  if (pr.author !== state.login) fail(1, 'GraphQL: ' + state.login + ' does not have the correct permissions to execute UpdatePullRequest');
  pr.body = body;
  out(repoUrl(state.origin) + '/pull/' + pr.number);
}

if (args[0] === 'api') {
  const o = options(args.slice(1), ['--method', '-X', '--hostname', '--input', '-H', '--header'], ['--paginate', '--slurp'], API_ARGV_FIELDS);
  if (o.values['--hostname'] !== HOST) contract('every gh api call names --hostname ' + HOST);
  if (o.positional.length !== 1) contract('gh api names one route');
  const method = (o.values['--method'] ?? o.values['-X'] ?? (o.values['--input'] !== undefined ? 'POST' : 'GET')).toUpperCase();
  const url = new URL(o.positional[0].replace(/^\//, ''), 'https://api.invalid/');
  if (url.origin !== 'https://api.invalid' || o.positional[0].includes('://')) contract('gh api names a route on --hostname ' + HOST + ', never a full URL');
  const route = url.pathname.slice(1);
  const repoRoute = /^repos\/([^/]+)\/([^/]+)\/(.*)$/.exec(route);
  if (route !== 'user' && !repoRoute) contract('unmodelled route ' + route);
  if (repoRoute && !same(repoRoute[1] + '/' + repoRoute[2], state.origin)) contract('route names ' + repoRoute[1] + '/' + repoRoute[2] + ', not the fixture repository ' + state.origin);
  const rest = repoRoute ? repoRoute[3] : '';
  const writeBody = () => {
    const raw = stdin(o, '--input');
    let parsed;
    try { parsed = JSON.parse(raw); } catch { fail(1, 'HTTP 400: Problems parsing JSON'); }
    if (typeof parsed !== 'object' || parsed === null || typeof parsed.body !== 'string' || Object.keys(parsed).length !== 1) contract('--input carries exactly {"body": <string>}');
    return withinLimit(parsed.body);
  };
  let m;
  if (route === 'user' && method === 'GET') out({ login: state.login });
  if ((m = /^issues\/([1-9][0-9]*)\/comments$/.exec(rest))) {
    if (method === 'GET') {
      if (o.values['--input'] !== undefined) contract('a GET carries no --input');
      const all = commentsOn(m[1]).map(asComment);
      const perPage = Math.min(Math.max(Number(url.searchParams.get('per_page') ?? PAGE) || PAGE, 1), 100);
      const pageList = [];
      for (let i = 0; i === 0 || i < all.length; i += perPage) pageList.push(all.slice(i, i + perPage));
      if (!o.flags.has('--paginate')) out(pageList[Number(url.searchParams.get('page') ?? 1) - 1] ?? []);
      out(o.flags.has('--slurp') ? JSON.stringify(pageList) : pageList.map((p) => JSON.stringify(p)).join(''));
    }
    if (method === 'POST') {
      const body = writeBody();
      failingOnce('comment-create');
      const comment = { id: state.nextCommentId++, login: state.login, body };
      commentsOn(m[1]).push(comment);
      out(asComment(comment));
    }
  }
  if ((m = /^issues\/comments\/([1-9][0-9]*)$/.exec(rest)) && method === 'PATCH') {
    const body = writeBody();
    failingOnce('comment-edit');
    const comment = Object.values(state.comments).flat().find((c) => c.id === Number(m[1]));
    if (!comment) fail(1, 'HTTP 404: Not Found');
    if (comment.login !== state.login) fail(1, 'HTTP 403: Resource not accessible by integration');
    comment.body = body;
    out(asComment(comment));
  }
  contract('unmodelled ' + method + ' ' + route);
}

contract('unmodelled gh operation');
} catch (e) {
  if (e !== DONE) {
    try { breach('internal error: ' + (e instanceof Error ? e.stack : String(e))); } catch {}
    process.stderr.write('adoption gh stand-in: internal error\n');
    process.exitCode = 98;
  }
} finally {
  fs.unlinkSync(lock);
}
`;

/**
 * Installs a stand-in `gh` at `<bin>/gh` for an adopted-PR run against the fixture repository `state.origin`.
 * It reads its state on every call, so a test changes GitHub mid-run with `set`/`update`, and it appends each
 * call to `logFile` in the format `readToolCalls` parses. It answers only:
 *
 * - `repo view github.com/<owner>/<name> --json <fields>`, for each of `repositories`: `nameWithOwner`, `url`,
 *   `defaultBranchRef`, `viewerPermission`.
 * - `pr view <n|branch|owner:branch> --repo github.com/<origin> --json <fields>` (a bare branch names its
 *   same-repository PR and `owner:branch` that owner's, an open one first) and `pr list --repo … [--head b] [--base b]
 *   [--state open|closed|merged|all, where closed includes merged as in gh] [--limit n] --json <fields>`, projecting `pulls` onto `number`, `url`,
 *   `state`, `title`, `body`, `isDraft`, `author`, `headRefName`, `headRefOid`, `baseRefName`,
 *   `isCrossRepository`, `headRepository`, `headRepositoryOwner` and `closingIssuesReferences`.
 *   `pr list --head` matches by branch name alone, so a fork's PR on a same-named branch is listed too.
 * - `pr create --repo … --draft --base b --head h --title t --body-file -`, which fails as GitHub does when `h`
 *   is not a branch on the bare remote or an open PR from `h` into `b` already exists; and
 *   `pr edit <n> --repo … --body-file -`, refused for a PR another login opened.
 * - `gh api --hostname github.com user`, and on `repos/<origin>/`: `issues/<n>/comments` (GET, one page of
 *   `ADOPTION_GH_PAGE_SIZE` or `?per_page=`, all pages with `--paginate`, as one array of pages with `--slurp`;
 *   POST with `--input -`), and `issues/comments/<id>` (PATCH with `--input -`, refused for another login's
 *   comment). `--input` carries exactly `{"body": …}`.
 *
 * It enforces two contracts, so a regression fails the test: every body arrives on stdin (`--body`, `-b`,
 * `-f`/`-F`/`--field`/`--raw-field` exit 97), and every call names the fixture repository and the host
 * (`--repo github.com/<origin>`, the `repo view` selector, or `gh api --hostname github.com` with a
 * `repos/<origin>/` route). Any other operation, option or `--json` field also exits 97 naming it. A body over
 * `GITHUB_BODY_LIMIT` is refused with HTTP 422, and each action in `failOnce` fails the next time it is attempted.
 */
export function installAdoptionGh(bin: string, config: StandInConfig, initial: Partial<AdoptionGhState> & Pick<AdoptionGhState, 'origin'>): AdoptionGh {
  mkdirSync(bin, { recursive: true });
  const stateFile = join(bin, 'adoption-gh.json');
  const read = (): AdoptionGhState => JSON.parse(readFileSync(stateFile, 'utf8')) as AdoptionGhState;
  const write = (state: AdoptionGhState): void => {
    writeFileSync(`${stateFile}.tmp`, JSON.stringify(state));
    renameSync(`${stateFile}.tmp`, stateFile);
  };
  // The stand-in's own lock, so a change made mid-run is never lost under a call that read the state first.
  const locked = (edit: (state: AdoptionGhState) => void): void => {
    const lock = `${stateFile}.lock`;
    for (;;) {
      try {
        closeSync(openSync(lock, 'wx'));
        break;
      } catch (e) {
        if (!(e instanceof Error && 'code' in e && e.code === 'EEXIST')) throw e;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
    }
    try {
      const state = read();
      edit(state);
      write(state);
    } finally {
      unlinkSync(lock);
    }
  };
  writeFileSync(join(bin, 'adoption-gh.config.json'), JSON.stringify(config));
  write({
    repositories: [{ nameWithOwner: initial.origin, defaultBranch: 'main', viewerPermission: 'WRITE' }],
    login: 'operator',
    pulls: [],
    comments: {},
    failOnce: [],
    nextPullNumber: 900,
    nextCommentId: 7001,
    ...initial,
  });
  writeFileSync(join(bin, 'gh'), `#!/usr/bin/env node\n${STAND_IN}`, { mode: 0o755 });
  const breachesFile = join(bin, BREACHES_FILE);
  return {
    read,
    breaches: () =>
      existsSync(breachesFile)
        ? readFileSync(breachesFile, 'utf8').split('\n').filter((line) => line.length > 0).map((line) => {
            const { why, args } = JSON.parse(line) as { why: string; args: string[] };
            return `${why} (gh ${JSON.stringify(args)})`;
          })
        : [],
    set: (patch) => locked((state) => Object.assign(state, patch)),
    update: locked,
  };
}
