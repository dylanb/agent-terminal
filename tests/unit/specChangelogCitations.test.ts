import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

// A changelog entry is how a reader dates a contract change, so every section it cites must be one the spec
// has or once had (an entry may record or recall a section's deletion or renumbering). An entry naming a
// clause the spec never had is the failure this pins.

type SpecTexts = Readonly<Record<string, string>>;

const REPO_ROOT = path.join(__dirname, '../..');
const SPEC_DIR = 'docs/spec';
const CHANGELOG = `${SPEC_DIR}/changelog.md`;

const ENTRY_MARKER = /> \*\*Changelog v(\d+)\.(\d+):\*\*/g;
const CITATION = /§(\d+(?:\.\d+)*[A-Z]?)/g;
const OTHER_DOCUMENT_NAME = /\b(?:UI|CODE|TICKET)-STANDARDS|\bTRACER-BULLET/;
const MARKDOWN_FILE = /[\w./-]*\w\.md\b/g;
const SPEC_FILE = /^(?:docs\/spec\/[^/]+|(?:[\w./-]*\/)?terminal-web-ui-spec)\.md$/;
const SENTENCE_END = /[.!?](?=\s)/g;
const HEADING = /^#{1,6}\s+(\d+(?:\.\d+)*[A-Z]?)(?=[.\s]|$)/;

interface Entry {
  readonly token: string;
  readonly text: string;
}

function newestEntry(changelog: string): Entry {
  const marks = [...changelog.matchAll(ENTRY_MARKER)];
  if (marks.length === 0) throw new Error('the changelog has no entry');
  let newest = 0;
  for (let i = 1; i < marks.length; i++) {
    const [a, b] = [marks[newest], marks[i]];
    const [aMaj, aMin, bMaj, bMin] = [Number(a[1]), Number(a[2]), Number(b[1]), Number(b[2])];
    if (bMaj > aMaj || (bMaj === aMaj && bMin > aMin)) newest = i;
  }
  const start = marks[newest].index ?? 0;
  const end = marks[newest + 1]?.index ?? changelog.length;
  return { token: marks[newest][0], text: changelog.slice(start, end) };
}

function namesOtherDocument(text: string): boolean {
  return OTHER_DOCUMENT_NAME.test(text) || [...text.matchAll(MARKDOWN_FILE)].some((m) => !SPEC_FILE.test(m[0]));
}

function citations(entryText: string): string[] {
  const out = new Set<string>();
  for (const m of entryText.matchAll(CITATION)) {
    const before = entryText.slice(0, m.index);
    const sentenceStart = Math.max(0, ...[...before.matchAll(SENTENCE_END)].map((e) => (e.index ?? 0) + 1));
    if (namesOtherDocument(before.slice(sentenceStart))) continue;
    out.add(m[1]);
  }
  return [...out];
}

function headings(specs: SpecTexts): Set<string> {
  const out = new Set<string>();
  for (const text of Object.values(specs))
    for (const line of text.split('\n')) {
      const m = line.match(HEADING);
      if (m) out.add(m[1]);
    }
  return out;
}

function hasNumberedItem(specs: SpecTexts, parent: string, item: string): boolean {
  for (const text of Object.values(specs)) {
    const lines = text.split('\n');
    const at = lines.findIndex((l) => l.match(HEADING)?.[1] === parent);
    if (at < 0) continue;
    for (const line of lines.slice(at + 1)) {
      if (/^#{1,6}\s/.test(line)) break;
      if (line.startsWith(`${item}. `)) return true;
    }
  }
  return false;
}

function unresolvedCitations(entryText: string, onDisk: SpecTexts, preEntry: SpecTexts): string[] {
  const now = headings(onDisk);
  const before = headings(preEntry);
  return citations(entryText).filter((c) => {
    if (now.has(c) || before.has(c)) return false;
    const dot = c.lastIndexOf('.');
    if (dot < 0 || !/^\d+$/.test(c.slice(dot + 1))) return true;
    const [parent, item] = [c.slice(0, dot), c.slice(dot + 1)];
    return !hasNumberedItem(onDisk, parent, item) && !hasNumberedItem(preEntry, parent, item);
  });
}

const GIT_REPOSITORY_ENV = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_COMMON_DIR',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_NAMESPACE',
] as const;

function gitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of GIT_REPOSITORY_ENV) delete env[key];
  return env;
}

function git(repoRoot: string, args: string[]): string {
  return execFileSync('git', args, { cwd: repoRoot, env: gitEnv(), encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

function readOnDiskSpecs(repoRoot: string): SpecTexts {
  const dir = path.join(repoRoot, SPEC_DIR);
  const out: Record<string, string> = {};
  for (const f of readdirSync(dir)) if (f.endsWith('.md') && `${SPEC_DIR}/${f}` !== CHANGELOG)
    out[f] = readFileSync(path.join(dir, f), 'utf8');
  return out;
}

function isCommitted(repoRoot: string, token: string): boolean {
  try {
    return git(repoRoot, ['--no-pager', 'show', `HEAD:${CHANGELOG}`]).includes(token);
  } catch {
    return false;
  }
}

function readPreEntrySpecs(repoRoot: string, token: string): SpecTexts {
  const log = git(repoRoot, ['-c', 'log.showSignature=false', '--no-pager', 'log', '--format=%H', '-S', token, '--', CHANGELOG]);
  const shas = log.split('\n').filter((l) => /^[0-9a-f]{40}$/.test(l));
  if (shas.length === 0) {
    if (isCommitted(repoRoot, token)) throw new Error(`no commit introduces ${token}; git log said: ${JSON.stringify(log)}`);
    return specsAt(repoRoot, 'HEAD');
  }
  return specsAt(repoRoot, `${shas[shas.length - 1]}^`);
}

function specsAt(repoRoot: string, rev: string): SpecTexts {
  const listing = git(repoRoot, ['--no-pager', 'ls-tree', '--name-only', rev, `${SPEC_DIR}/`]);
  const out: Record<string, string> = {};
  for (const file of listing.split('\n').filter((f) => f.endsWith('.md') && f !== CHANGELOG))
    out[path.basename(file)] = git(repoRoot, ['--no-pager', 'show', `${rev}:${file}`]);
  return out;
}

function everHadHeading(repoRoot: string, section: string): boolean {
  const pattern = `^#{1,6}[[:space:]]+${section.replace(/\./g, '\\.')}([.[:space:]]|$)`;
  const log = git(repoRoot, ['--no-pager', 'log', '--format=%H', '-G', pattern, '--', SPEC_DIR, `:(exclude)${CHANGELOG}`]);
  return log.trim() !== '';
}

function unresolvedInNewestEntry(repoRoot: string): string[] {
  const entry = newestEntry(readFileSync(path.join(repoRoot, CHANGELOG), 'utf8'));
  const onDisk = readOnDiskSpecs(repoRoot);
  return unresolvedCitations(entry.text, onDisk, readPreEntrySpecs(repoRoot, entry.token)).filter(
    (c) => !everHadHeading(repoRoot, c),
  );
}

describe('the newest changelog entry cites only sections the spec has', () => {
  it('every section the newest entry cites resolves', () => {
    expect(unresolvedInNewestEntry(REPO_ROOT)).toEqual([]);
  });
});

describe('citation resolution', () => {
  const spec = (body: string): SpecTexts => ({ '99-fixture.md': body });

  it('skips a citation prefixed by another document name', () => {
    const entry = '> **Changelog v9.1:** per UI-STANDARDS §97.4 and CODE-STANDARDS §98, and notes.md §96.1.';
    expect(unresolvedCitations(entry, spec('## 99. Fixture\n'), spec(''))).toEqual([]);
  });

  it('skips a citation later in a sentence that names another document', () => {
    const entry = '> **Changelog v9.1:** **Design doc:** `design/plan.md` drops its slice (citing §99), its §4.2 item 4. Then §97 changed.';
    expect(unresolvedCitations(entry, spec('## 99. Fixture\n'), spec(''))).toEqual(['97']);
  });

  it("checks a citation after a name of one of the spec's own files", () => {
    const entry = '> **Changelog v9.1:** `docs/spec/27-loop.md` gains §97.1; `terminal-web-ui-spec.md` adds §98.';
    expect(unresolvedCitations(entry, spec('## 99. Fixture\n'), spec(''))).toEqual(['97.1', '98']);
  });

  it('checks a citation in the sentence after one that names another document', () => {
    const entry = '> **Changelog v9.1:** `design/plan.md` drops A4. §97 amended. `x.md` too. `y` §98 too.';
    expect(unresolvedCitations(entry, spec('## 99. Fixture\n'), spec(''))).toEqual(['97', '98']);
  });

  it('resolves a heading present only in the pre-entry spec', () => {
    const entry = '> **Changelog v9.1:** §99.3 removed.';
    expect(unresolvedCitations(entry, spec('## 99. Fixture\n'), spec('### 99.3 Gone\n'))).toEqual([]);
  });

  it('resolves a heading present only in the on-disk spec', () => {
    const entry = '> **Changelog v9.1:** §99.4.1 added.';
    expect(unresolvedCitations(entry, spec('#### 99.4.1 New\n'), spec(''))).toEqual([]);
  });

  it('reports a citation behind an all-caps word that names no document', () => {
    const entry = '> **Changelog v9.1:** the IPC §97 row and AC6 §98.';
    expect(unresolvedCitations(entry, spec('## 99. Fixture\n'), spec(''))).toEqual(['97', '98']);
  });

  it("resolves a numbered item in the parent heading's own body", () => {
    const entry = '> **Changelog v9.1:** §99.2 amended.';
    const body = '## 99. Fixture\n\n1. first\n2. second\n\n### 99.1 Child\n';
    expect(unresolvedCitations(entry, spec(body), spec(''))).toEqual([]);
  });

  it("does not resolve a numbered item that sits under a sub-heading, not the parent's own body", () => {
    const entry = '> **Changelog v9.1:** §99.2 amended.';
    const body = '## 99. Fixture\n\n### 99.1 Child\n\n1. first\n2. second\n';
    expect(unresolvedCitations(entry, spec(body), spec(''))).toEqual(['99.2']);
  });

  it("resolves a numbered item present only in the pre-entry spec's parent body", () => {
    const entry = '> **Changelog v9.1:** §99.2 removed.';
    const before = '## 99. Fixture\n\n1. first\n2. second\n';
    expect(unresolvedCitations(entry, spec('## 99. Fixture\n\n1. first\n'), spec(before))).toEqual([]);
  });

  it('names a citation that resolves nowhere, with its trailing clause letter stripped', () => {
    const entry = '> **Changelog v9.1:** §99.9(b) and §99.1 amended.';
    expect(unresolvedCitations(entry, spec('## 99. Fixture\n### 99.1 Child\n'), spec(''))).toEqual(['99.9']);
  });
});

describe('the pre-entry anchor in a git history', () => {
  let repo: string | undefined;
  afterEach(() => {
    if (repo) rmSync(repo, { recursive: true, force: true });
    repo = undefined;
  });

  const write = (file: string, text: string): void => {
    mkdirSync(path.dirname(path.join(repo as string, file)), { recursive: true });
    writeFileSync(path.join(repo as string, file), text);
  };
  const commit = (message: string): void => {
    git(repo as string, ['add', '-A']);
    git(repo as string, ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '-q', '--no-verify', '-m', message]);
  };

  function seed(): void {
    repo = mkdtempSync(path.join(tmpdir(), 'spec-citations-'));
    git(repo, ['init', '-q']);
    write(`${SPEC_DIR}/99-fixture.md`, '## 99. Fixture\n### 99.3 Doomed\n');
    write(CHANGELOG, '> **Changelog v9.0:** §99.3 added.\n');
    commit('base');
  }

  it('an entry whose prose was edited later still anchors at the commit that introduced it', () => {
    seed();
    write(`${SPEC_DIR}/99-fixture.md`, '## 99. Fixture\n');
    write(CHANGELOG, '> **Changelog v9.1:** §99.3 removed.\n\n> **Changelog v9.0:** §99.3 added.\n');
    commit('entry');
    write(CHANGELOG, '> **Changelog v9.1:** §99.3 removed, reworded.\n\n> **Changelog v9.0:** §99.3 added.\n');
    commit('reword');
    expect(unresolvedInNewestEntry(repo as string)).toEqual([]);
  });

  it('a section deleted before the pre-entry anchor still resolves', () => {
    seed();
    write(`${SPEC_DIR}/99-fixture.md`, '## 99. Fixture\n');
    write(CHANGELOG, '> **Changelog v9.1:** §99.3 removed.\n\n> **Changelog v9.0:** §99.3 added.\n');
    commit('delete');
    write(CHANGELOG, '> **Changelog v9.2:** §99.3, deleted at v9.1, recalled.\n\n> **Changelog v9.1:** §99.3 removed.\n\n> **Changelog v9.0:** §99.3 added.\n');
    commit('recall');
    expect(unresolvedInNewestEntry(repo as string)).toEqual([]);
  });

  it('an uncommitted entry resolves against the on-disk spec', () => {
    seed();
    write(`${SPEC_DIR}/99-fixture.md`, '## 99. Fixture\n### 99.3 Doomed\n### 99.5 Fresh\n');
    write(CHANGELOG, '> **Changelog v9.1:** §99.5 added; §99.7 too.\n\n> **Changelog v9.0:** §99.3 added.\n');
    expect(unresolvedInNewestEntry(repo as string)).toEqual(['99.7']);
  });

  it("a fixture repo's git writes stay out of an inherited index", () => {
    const outer = mkdtempSync(path.join(tmpdir(), 'spec-citations-outer-'));
    const saved = process.env.GIT_INDEX_FILE;
    process.env.GIT_INDEX_FILE = path.join(outer, 'index');
    try {
      seed();
      expect(readdirSync(outer)).toEqual([]);
      expect(git(repo as string, ['--no-pager', 'log', '--format=%s'])).toBe('base\n');
    } finally {
      if (saved === undefined) delete process.env.GIT_INDEX_FILE;
      else process.env.GIT_INDEX_FILE = saved;
      rmSync(outer, { recursive: true, force: true });
    }
  });

  it('a committed spec file larger than the default child-process output buffer still resolves', () => {
    seed();
    write(`${SPEC_DIR}/99-fixture.md`, `## 99. Fixture\n### 99.3 Doomed\n${'x'.repeat(2 * 1024 * 1024)}\n`);
    commit('grow');
    write(`${SPEC_DIR}/99-fixture.md`, '## 99. Fixture\n');
    write(CHANGELOG, '> **Changelog v9.1:** §99.3 removed.\n\n> **Changelog v9.0:** §99.3 added.\n');
    commit('delete');
    expect(unresolvedInNewestEntry(repo as string)).toEqual([]);
  });

  it('an entry first committed in a merge resolution, which git log -S cannot find, fails loudly', () => {
    seed();
    git(repo as string, ['checkout', '-q', '-b', 'side']);
    write(CHANGELOG, '> **Changelog v9.0:** §99.3 added, side.\n');
    commit('side');
    git(repo as string, ['checkout', '-q', '-']);
    write(CHANGELOG, '> **Changelog v9.0:** §99.3 added, main.\n');
    commit('main');
    expect(() => git(repo as string, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'merge', '-q', 'side'])).toThrow();
    write(CHANGELOG, '> **Changelog v9.1:** §99.3 kept.\n\n> **Changelog v9.0:** §99.3 added.\n');
    commit('merge');
    expect(() => unresolvedInNewestEntry(repo as string)).toThrow(/no commit introduces/);
  });

  function seedItems(): void {
    repo = mkdtempSync(path.join(tmpdir(), 'spec-citations-'));
    git(repo, ['init', '-q']);
    write(`${SPEC_DIR}/99-fixture.md`, '## 99. Fixture\n\n1. first\n2. second\n');
    write(CHANGELOG, '> **Changelog v9.0:** §99 added.\n');
    commit('base');
  }

  it('a numbered item a committed entry deletes resolves against the spec before that entry', () => {
    seedItems();
    write(`${SPEC_DIR}/99-fixture.md`, '## 99. Fixture\n\n1. first\n');
    write(CHANGELOG, '> **Changelog v9.1:** §99.2 removed.\n\n> **Changelog v9.0:** §99 added.\n');
    commit('entry');
    write(CHANGELOG, '> **Changelog v9.1:** §99.2 removed, reworded.\n\n> **Changelog v9.0:** §99 added.\n');
    commit('reword');
    expect(unresolvedInNewestEntry(repo as string)).toEqual([]);
  });

  it('a numbered item an uncommitted entry deletes resolves against the committed spec', () => {
    seedItems();
    write(`${SPEC_DIR}/99-fixture.md`, '## 99. Fixture\n\n1. first\n');
    write(CHANGELOG, '> **Changelog v9.1:** §99.2 removed; §99.3 too.\n\n> **Changelog v9.0:** §99 added.\n');
    expect(unresolvedInNewestEntry(repo as string)).toEqual(['99.3']);
  });

  it('an uncommitted entry recording a deletion resolves against the committed spec', () => {
    seed();
    write(`${SPEC_DIR}/99-fixture.md`, '## 99. Fixture\n');
    write(CHANGELOG, '> **Changelog v9.1:** §99.3 removed.\n\n> **Changelog v9.0:** §99.3 added.\n');
    expect(unresolvedInNewestEntry(repo as string)).toEqual([]);
  });
});
