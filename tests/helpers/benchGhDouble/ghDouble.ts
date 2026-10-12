// The `gh` test double (#180 test boundary): GitHub for the benchmark's whole-run tests, with no network. It
// serves the subcommands the app's bootstrap and gate side effects, the benchmark's scratch-repository adapter
// and a scripted agent call, keeps their effects in its store, and records every call. A created repository
// is a local bare repository that git reaches through its https URL by an `insteadOf` rewrite in the caller's
// global git config. It has no safety role.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  GH_DOUBLE_STORE_ENV,
  appendCall,
  matchRule,
  newRepo,
  readScript,
  readState,
  withLock,
  writeState,
  type GhIssue,
  type GhPull,
  type GhRepo,
  type GhState,
} from './store';

const VERSION = 'gh version 2.99.0-double (2020-01-01)';
const LOGIN = 'bench-user';
const HOST = 'github.com';

class GhError extends Error {
  constructor(
    message: string,
    readonly code = 1,
  ) {
    super(message);
  }
}

const store = process.env[GH_DOUBLE_STORE_ENV] ?? '';
if (store === '') {
  process.stderr.write(`gh double: ${GH_DOUBLE_STORE_ENV} is not set\n`);
  process.exit(2);
}

const VALUE_FLAGS = new Set([
  '--repo', '-R', '--json', '-q', '--jq', '--title', '-t', '--body', '-b', '--body-file', '-F', '--base', '-B', '--head', '-H',
  '--description', '--add-label', '--remove-label', '--add-assignee', '--remove-assignee', '--add-topic', '--remove-topic',
  '--state', '-s', '--limit', '-L', '--search', '-S', '--topic', '--label', '-l', '--hostname', '-h', '--git-protocol',
  '-X', '--method', '-f', '--raw-field', '--field', '--template', '--visibility', '--homepage', '--source', '--remote',
]);

interface Parsed {
  positional: string[];
  flags: Map<string, string[]>;
}

function parse(argv: string[]): Parsed {
  const positional: string[] = [];
  const flags = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('-') && a !== '-') {
      const eq = a.indexOf('=');
      const name = eq > 0 ? a.slice(0, eq) : a;
      const value = eq > 0 ? a.slice(eq + 1) : VALUE_FLAGS.has(a) ? (argv[++i] ?? '') : '';
      flags.set(name, [...(flags.get(name) ?? []), value]);
    } else positional.push(a);
  }
  return { positional, flags };
}

const flag = (p: Parsed, ...names: string[]): string | undefined => {
  for (const n of names) {
    const v = p.flags.get(n);
    if (v !== undefined) return v[v.length - 1];
  }
  return undefined;
};
const flagAll = (p: Parsed, ...names: string[]): string[] => names.flatMap((n) => p.flags.get(n) ?? []);
const has = (p: Parsed, ...names: string[]): boolean => names.some((n) => p.flags.has(n));

function readStdin(): string {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function ghConfigDir(): string {
  const dir = process.env.GH_CONFIG_DIR;
  return dir !== undefined && dir !== '' ? dir : join(process.env.HOME ?? '', '.config', 'gh');
}

function storedToken(): string | null {
  const file = join(ghConfigDir(), 'hosts.yml');
  if (!existsSync(file)) return null;
  return readFileSync(file, 'utf8').match(/oauth_token:\s*(\S+)/)?.[1] ?? null;
}

function credential(): { kind: 'hosts' | 'env'; token: string } | null {
  for (const name of ['GH_TOKEN', 'GITHUB_TOKEN']) {
    const v = process.env[name];
    if (v !== undefined && v !== '') return { kind: 'env', token: v };
  }
  const t = storedToken();
  return t === null ? null : { kind: 'hosts', token: t };
}

function git(args: string[], cwd: string = process.cwd()): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function slugFromUrl(url: string): string | null {
  const m = url.trim().match(/^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

function selectorSlug(value: string): string {
  const parts = value.split('/');
  if (parts.length === 3) return `${parts[1]}/${parts[2]}`;
  if (parts.length === 2) return value;
  throw new GhError(`expected the "[HOST/]OWNER/REPO" format, got "${value}"`);
}

function targetSlug(p: Parsed): string {
  const explicit = flag(p, '--repo', '-R');
  if (explicit !== undefined) return selectorSlug(explicit);
  let origin = '';
  try {
    origin = git(['config', '--get', 'remote.origin.url']);
  } catch {
    throw new GhError('could not determine base repository: no git remote named origin');
  }
  const slug = slugFromUrl(origin);
  if (slug === null) throw new GhError('none of the git remotes configured for this repository point to a known GitHub host');
  return slug;
}

function repoOf(state: GhState, slug: string): GhRepo {
  const r = state.repos[slug];
  if (r === undefined) throw new GhError(`GraphQL: Could not resolve to a Repository with the name '${slug}'. (repository)`);
  return r;
}

const url = (slug: string, kind?: 'issues' | 'pull', n?: number): string => `https://${HOST}/${slug}${kind ? `/${kind}/${n}` : ''}`;

function select(doc: unknown, p: Parsed): string {
  const fields = flag(p, '--json');
  let out: unknown = doc;
  if (fields !== undefined && fields !== '') {
    const pick = (o: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(fields.split(',').map((f) => [f, o[f]]));
    out = Array.isArray(doc) ? doc.map((d) => pick(d as Record<string, unknown>)) : pick(doc as Record<string, unknown>);
  }
  const q = flag(p, '-q', '--jq');
  if (q !== undefined) {
    const path = q.replace(/^\./, '').split('.').filter((s) => s.length > 0);
    for (const k of path) out = (out as Record<string, unknown> | undefined)?.[k];
    if (typeof out === 'string') return out.endsWith('\n') ? out : `${out}\n`;
  }
  return `${JSON.stringify(out)}\n`;
}

function bodyFrom(p: Parsed): string | undefined {
  const file = flag(p, '--body-file', '-F');
  if (file !== undefined) return file === '-' ? readStdin() : readFileSync(file, 'utf8');
  return flag(p, '--body', '-b');
}

function issueDoc(r: GhRepo, i: GhIssue): Record<string, unknown> {
  return {
    number: i.number,
    title: i.title,
    body: i.body,
    state: i.state,
    url: url(r.slug, 'issues', i.number),
    labels: i.labels.map((name) => ({ name })),
    assignees: i.assignees.map((login) => ({ login })),
    comments: i.comments.map((body) => ({ body })),
  };
}

function pullDoc(r: GhRepo, pr: GhPull): Record<string, unknown> {
  const [owner, name] = r.slug.split('/');
  return {
    ...issueDoc(r, pr),
    url: url(r.slug, 'pull', pr.number),
    baseRefName: pr.base,
    headRefName: pr.head,
    headRefOid: pr.headOid,
    isDraft: pr.isDraft,
    isCrossRepository: false,
    headRepository: { name },
    headRepositoryOwner: { login: owner },
    closingIssuesReferences: [],
  };
}

function repoDoc(r: GhRepo): Record<string, unknown> {
  let branch = 'main';
  try {
    branch = git(['--git-dir', r.bare, 'symbolic-ref', '--short', 'HEAD']);
  } catch {
    /* an empty bare repository still names its unborn default branch */
  }
  return {
    nameWithOwner: r.slug,
    name: r.slug.split('/')[1],
    url: url(r.slug),
    description: r.description,
    isPrivate: r.private,
    visibility: r.private ? 'PRIVATE' : 'PUBLIC',
    defaultBranchRef: { name: branch },
    repositoryTopics: r.topics.map((name) => ({ name })),
  };
}

function findIssue(r: GhRepo, n: string): GhIssue {
  const i = r.issues.find((x) => String(x.number) === n) ?? r.pulls.find((x) => String(x.number) === n);
  if (i === undefined) throw new GhError(`GraphQL: Could not resolve to an issue or pull request with the number of ${n}. (repository.issue)`);
  return i;
}

function findPull(r: GhRepo, ref: string | undefined): GhPull {
  const key = ref ?? git(['rev-parse', '--abbrev-ref', 'HEAD']);
  const pr = r.pulls.find((x) => String(x.number) === key) ?? r.pulls.find((x) => x.head === key && x.state === 'OPEN');
  if (pr === undefined) throw new GhError(`no pull requests found for branch "${key}"`);
  return pr;
}

function editLabels(item: GhIssue, p: Parsed, repo: GhRepo): void {
  for (const l of flagAll(p, '--add-label').flatMap((v) => v.split(','))) {
    if (!item.labels.includes(l)) item.labels.push(l);
    if (!repo.labels.includes(l)) repo.labels.push(l);
  }
  for (const l of flagAll(p, '--remove-label').flatMap((v) => v.split(','))) item.labels = item.labels.filter((x) => x !== l);
  for (const a of flagAll(p, '--add-assignee')) item.assignees.push(a === '@me' ? LOGIN : a);
}

function registerRewrite(bare: string, slug: string): void {
  for (const from of [url(slug), `${url(slug)}.git`]) git(['config', '--global', '--add', `url.file://${bare}.insteadOf`, from]);
}

type Handler = (p: Parsed, state: GhState) => string;

const handlers: Record<string, Handler> = {
  'repo create': (p, state) => {
    const raw = p.positional[2] ?? '';
    const slug = raw.includes('/') ? raw : `${LOGIN}/${raw}`;
    if (state.repos[slug] !== undefined) throw new GhError('GraphQL: Name already exists on this account (createRepository)');
    const r = newRepo(store, slug, { private: !has(p, '--public'), description: flag(p, '--description') ?? '' });
    mkdirSync(r.bare, { recursive: true });
    git(['init', '-q', '--bare', '-b', 'main', r.bare]);
    registerRewrite(r.bare, slug);
    state.repos[slug] = r;
    return `${url(slug)}\n`;
  },
  'repo view': (p, state) => select(repoDoc(repoOf(state, p.positional[2] !== undefined ? selectorSlug(p.positional[2]) : targetSlug(p))), p),
  'repo edit': (p, state) => {
    const r = repoOf(state, p.positional[2] !== undefined ? selectorSlug(p.positional[2]) : targetSlug(p));
    for (const t of flagAll(p, '--add-topic').flatMap((v) => v.split(','))) if (!r.topics.includes(t)) r.topics.push(t);
    for (const t of flagAll(p, '--remove-topic').flatMap((v) => v.split(','))) r.topics = r.topics.filter((x) => x !== t);
    const d = flag(p, '--description');
    if (d !== undefined) r.description = d;
    return '';
  },
  'repo delete': (p, state) => {
    const slug = selectorSlug(p.positional[2] ?? targetSlug(p));
    const r = repoOf(state, slug);
    if (!has(p, '--yes')) throw new GhError('--yes required when not running interactively');
    rmSync(r.bare, { recursive: true, force: true });
    delete state.repos[slug];
    return '';
  },
  'repo list': (p, state) => {
    const owner = p.positional[2] ?? LOGIN;
    const topic = flag(p, '--topic');
    const docs = Object.values(state.repos)
      .filter((r) => r.slug.startsWith(`${owner}/`) && (topic === undefined || r.topics.includes(topic)))
      .map(repoDoc);
    return select(docs, p);
  },
  'issue create': (p, state) => {
    const r = repoOf(state, targetSlug(p));
    const i: GhIssue = { number: r.nextNumber++, title: flag(p, '--title', '-t') ?? '', body: bodyFrom(p) ?? '', state: 'OPEN', labels: [], assignees: [], comments: [] };
    editLabels(i, { positional: [], flags: new Map([['--add-label', flagAll(p, '--label', '-l')]]) }, r);
    r.issues.push(i);
    return `${url(r.slug, 'issues', i.number)}\n`;
  },
  'issue view': (p, state) => {
    const r = repoOf(state, targetSlug(p));
    const i = findIssue(r, p.positional[2] ?? '');
    if (flag(p, '--json') === undefined) return `title:\t${i.title}\nstate:\t${i.state}\n--\n${i.body}`;
    return select(issueDoc(r, i), p);
  },
  'issue list': (p, state) => {
    const r = repoOf(state, targetSlug(p));
    return select(r.issues.map((i) => issueDoc(r, i)), p);
  },
  'issue edit': (p, state) => {
    const r = repoOf(state, targetSlug(p));
    const i = findIssue(r, p.positional[2] ?? '');
    const body = bodyFrom(p);
    if (body !== undefined) i.body = body;
    const title = flag(p, '--title', '-t');
    if (title !== undefined) i.title = title;
    editLabels(i, p, r);
    return `${url(r.slug, 'issues', i.number)}\n`;
  },
  'issue comment': (p, state) => {
    const r = repoOf(state, targetSlug(p));
    findIssue(r, p.positional[2] ?? '').comments.push(bodyFrom(p) ?? '');
    return `${url(r.slug, 'issues', Number(p.positional[2]))}#issuecomment-1\n`;
  },
  'issue close': (p, state) => {
    findIssue(repoOf(state, targetSlug(p)), p.positional[2] ?? '').state = 'CLOSED';
    return '';
  },
  'pr create': (p, state) => {
    const r = repoOf(state, targetSlug(p));
    const head = (flag(p, '--head', '-H') ?? git(['rev-parse', '--abbrev-ref', 'HEAD'])).replace(/^[^:]+:/, '');
    let headOid: string;
    try {
      headOid = git(['--git-dir', r.bare, 'rev-parse', '--verify', `refs/heads/${head}`]);
    } catch {
      throw new GhError(`pull request create failed: GraphQL: Head sha can't be blank, Head ref must be a branch (createPullRequest)`);
    }
    const pr: GhPull = {
      number: r.nextNumber++,
      title: flag(p, '--title', '-t') ?? '',
      body: bodyFrom(p) ?? '',
      state: 'OPEN',
      labels: [],
      assignees: [],
      comments: [],
      base: flag(p, '--base', '-B') ?? 'main',
      head,
      headOid,
      isDraft: has(p, '--draft', '-d'),
    };
    r.pulls.push(pr);
    return `${url(r.slug, 'pull', pr.number)}\n`;
  },
  'pr view': (p, state) => {
    const r = repoOf(state, targetSlug(p));
    return select(pullDoc(r, findPull(r, p.positional[2])), p);
  },
  'pr list': (p, state) => {
    const r = repoOf(state, targetSlug(p));
    const st = (flag(p, '--state', '-s') ?? 'open').toUpperCase();
    const base = flag(p, '--base', '-B');
    const head = flag(p, '--head', '-H');
    const docs = r.pulls
      .filter((pr) => (st === 'ALL' || pr.state === st) && (base === undefined || pr.base === base) && (head === undefined || pr.head === head))
      .map((pr) => pullDoc(r, pr));
    return select(docs, p);
  },
  'pr ready': (p, state) => {
    findPull(repoOf(state, targetSlug(p)), p.positional[2]).isDraft = false;
    return '';
  },
  'pr close': (p, state) => {
    findPull(repoOf(state, targetSlug(p)), p.positional[2]).state = 'CLOSED';
    return '';
  },
  'pr edit': (p, state) => {
    const r = repoOf(state, targetSlug(p));
    const pr = findPull(r, p.positional[2]);
    const body = bodyFrom(p);
    if (body !== undefined) pr.body = body;
    editLabels(pr, p, r);
    return `${url(r.slug, 'pull', pr.number)}\n`;
  },
  'pr comment': (p, state) => {
    const r = repoOf(state, targetSlug(p));
    findPull(r, p.positional[2]).comments.push(bodyFrom(p) ?? '');
    return '';
  },
  'label list': (p, state) => {
    const r = repoOf(state, targetSlug(p));
    const search = flag(p, '--search', '-S') ?? '';
    return select(r.labels.filter((l) => l.includes(search)).map((name) => ({ name })), p);
  },
  'label create': (p, state) => {
    const r = repoOf(state, targetSlug(p));
    const name = p.positional[2] ?? '';
    if (!r.labels.includes(name)) r.labels.push(name);
    return '';
  },
  api: (p, state) => {
    const endpoint = (p.positional[1] ?? '').replace(/^\//, '');
    const m = endpoint.match(/^repos\/([^/]+\/[^/]+)$/);
    if (m && (flag(p, '-X', '--method') ?? 'GET') === 'GET') return select(repoDoc(repoOf(state, m[1])), p);
    return '{}\n';
  },
};

function auth(p: Parsed): string {
  const sub = p.positional[1];
  if (sub === 'login') {
    if (!has(p, '--with-token')) throw new GhError('only --with-token is supported by the double');
    const token = readStdin().trim();
    mkdirSync(ghConfigDir(), { recursive: true });
    writeFileSync(join(ghConfigDir(), 'hosts.yml'), `${HOST}:\n    oauth_token: ${token}\n    git_protocol: https\n    user: ${LOGIN}\n`);
    return '';
  }
  const cred = credential();
  if (sub === 'token') {
    if (cred === null) throw new GhError(`no oauth token found for ${HOST}`);
    return `${cred.token}\n`;
  }
  if (sub === 'status') {
    if (cred === null) throw new GhError('You are not logged into any GitHub hosts. To log in, run: gh auth login');
    return `${HOST}\n  ✓ Logged in to ${HOST} account ${LOGIN}\n`;
  }
  if (sub === 'git-credential') {
    if (p.positional[2] !== 'get') return '';
    const input = readStdin();
    if (!/^host=github\.com$/m.test(input) || cred === null) throw new GhError('', 1);
    return `protocol=https\nhost=${HOST}\nusername=x-access-token\npassword=${cred.token}\n`;
  }
  throw new GhError(`unsupported by the double: gh auth ${sub ?? ''}`);
}

function main(): void {
  const argv = process.argv.slice(2);
  const p = parse(argv);
  const command = p.positional[0] === 'api' ? 'api' : `${p.positional[0] ?? ''} ${p.positional[1] ?? ''}`;
  const cred = credential();
  const call = { argv, cwd: process.cwd(), repo: null as string | null, credential: cred?.kind ?? null, refused: false, hung: false, code: 0 };
  const done = (code: number, stdout: string, stderr: string): never => {
    call.code = code;
    appendCall(store, call);
    process.stdout.write(stdout);
    process.stderr.write(stderr);
    process.exit(code);
  };

  const rule = matchRule(readScript(store), argv);
  if (rule?.action === 'hang') {
    appendCall(store, { ...call, hung: true });
    setInterval(() => {}, 1 << 30);
    return;
  }
  if (rule?.action === 'fail') done(rule.code ?? 1, '', `${rule.stderr ?? 'scripted failure'}\n`);

  if (has(p, '--version') || p.positional[0] === 'version') done(0, `${VERSION}\n`, '');
  const authFree = p.positional[0] === 'auth' && (p.positional[1] === 'login' || p.positional[1] === 'logout');
  if (!authFree && cred === null) {
    call.refused = true;
    done(4, '', 'To get started with GitHub CLI, please run:  gh auth login\nAlternatively, populate the GH_TOKEN environment variable with a GitHub API authentication token.\n');
  }
  try {
    if (p.positional[0] === 'auth') done(0, auth(p), '');
    const handler = handlers[command];
    if (handler === undefined) throw new GhError(`unsupported by the double: gh ${command}`);
    const out = withLock(store, () => {
      const state = readState(store);
      try {
        call.repo = p.positional[0] === 'repo' && p.positional[2] !== undefined ? selectorSlug(p.positional[2]) : targetSlug(p);
      } catch {
        call.repo = null;
      }
      const result = handler(p, state);
      writeState(store, state);
      return result;
    });
    done(0, out, '');
  } catch (e) {
    if (e instanceof GhError) done(e.code, '', e.message === '' ? '' : `${e.message}\n`);
    done(1, '', `${e instanceof Error ? e.message : String(e)}\n`);
  }
}

main();
