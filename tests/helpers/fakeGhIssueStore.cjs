// The fake `gh` issue store (tests/e2e/fakeTools.ts seedFakeGhGit): the one reader and writer of a store's
// files, run by the shim as `node fakeGhIssueStore.cjs <op> <log> ...` and by the TS seeders. An issue's body
// lives in `<log>.issue-body.<n>`, the sink the shim's `issue create` and `issue edit --body-file -` arms write;
// its title, labels and comments live in `<log>.issue.<n>.json`. Exit 3 from `view` means "not held here".

'use strict';
const fs = require('node:fs');

const NOT_HELD = 3;
const COMMENT_AUTHOR = 'fake-user';
const COMMENT_EPOCH_MS = Date.UTC(2026, 0, 1);
const FIELDS = new Set(['number', 'title', 'body', 'labels', 'comments', 'url']);
const VALUE_FLAGS = new Set(['--repo', '-R', '--json', '-q', '--jq', '--title', '-t', '--body', '-b', '--body-file', '-F', '--label', '-l', '--assignee', '-a', '--milestone', '-m', '--project', '-p', '--template', '-T']);

const recordFile = (log, n) => `${log}.issue.${n}.json`;
const bodyFile = (log, n) => `${log}.issue-body.${n}`;
const readIf = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null);

/** `gh issue <sub> ...` argv → its positionals and its flags (repeatable ones keep every value, in order). */
function parseArgs(args) {
  const positionals = [];
  const flags = new Map();
  for (let i = 2; i < args.length; i++) {
    const a = args[i];
    const eq = a.startsWith('--') ? a.indexOf('=') : -1;
    const name = eq > 0 ? a.slice(0, eq) : a;
    if (VALUE_FLAGS.has(name)) {
      const value = eq > 0 ? a.slice(eq + 1) : args[++i];
      flags.set(name, [...(flags.get(name) ?? []), value]);
    } else if (!a.startsWith('-')) positionals.push(a);
  }
  const flag = (...names) => names.flatMap((n) => flags.get(n) ?? []);
  return { positionals, flag };
}

function readRecord(log, n) {
  const text = readIf(recordFile(log, n));
  if (text === null) return null;
  return { ...JSON.parse(text), body: readIf(bodyFile(log, n)) ?? '' };
}

function writeRecord(log, n, record) {
  const { body, ...rest } = record;
  fs.writeFileSync(recordFile(log, n), JSON.stringify(rest));
  if (body !== undefined) fs.writeFileSync(bodyFile(log, n), body);
}

const ghShape = (r) => ({
  number: r.number,
  title: r.title,
  body: r.body,
  labels: r.labels.map((name) => ({ name })),
  comments: r.comments.map((c) => ({ author: { login: c.author }, createdAt: c.createdAt, body: c.body })),
  url: `https://github.com/fake/repo/issues/${r.number}`,
});

const fail = (message) => {
  process.stderr.write(`fake gh: ${message}\n`);
  process.exit(1);
};

const ops = {
  seed(log) {
    const issue = JSON.parse(fs.readFileSync(0, 'utf8'));
    writeRecord(log, issue.number, issue);
  },
  dump(log, n) {
    const r = readRecord(log, Number(n));
    process.stdout.write(JSON.stringify(r));
  },
  'record-create'(log, n, ...args) {
    const { flag } = parseArgs(args);
    const labels = flag('--label', '-l').flatMap((v) => v.split(',')).map((v) => v.trim()).filter((v) => v.length > 0);
    writeRecord(log, Number(n), { number: Number(n), title: flag('--title', '-t').at(-1) ?? '', labels, comments: [] });
  },
  comment(log, ...args) {
    const { positionals, flag } = parseArgs(args);
    const n = Number(positionals[0]);
    const r = readRecord(log, n);
    if (r === null) fail(`no issue ${positionals[0]} in the store`);
    const file = flag('--body-file', '-F').at(-1);
    const body = file === undefined ? (flag('--body', '-b').at(-1) ?? '') : fs.readFileSync(file === '-' ? 0 : file, 'utf8');
    const seqFile = `${log}.comment-seq`;
    const seq = Number(readIf(seqFile) ?? '0') + 1;
    fs.writeFileSync(seqFile, String(seq));
    const createdAt = new Date(COMMENT_EPOCH_MS + seq * 1000).toISOString().replace('.000Z', 'Z');
    writeRecord(log, n, { ...r, body: undefined, comments: [...r.comments, { author: COMMENT_AUTHOR, createdAt, body }] });
  },
  view(log, ...args) {
    const { positionals, flag } = parseArgs(args);
    const r = readRecord(log, Number(positionals[0]));
    if (r === null) process.exit(NOT_HELD);
    const fields = (flag('--json').at(-1) ?? '').split(',').filter((f) => f.length > 0);
    if (fields.length === 0) fail('issue view needs --json');
    const unknown = fields.find((f) => !FIELDS.has(f));
    if (unknown !== undefined) fail(`unknown JSON field: "${unknown}"`);
    const shaped = ghShape(r);
    const jq = flag('-q', '--jq').at(-1);
    if (jq === undefined) {
      process.stdout.write(`${JSON.stringify(Object.fromEntries(fields.map((f) => [f, shaped[f]])))}\n`);
    } else if (jq === '.body' || jq === '.title') {
      process.stdout.write(`${shaped[jq.slice(1)]}\n`);
    } else if (jq === '.labels[].name') {
      process.stdout.write(r.labels.map((l) => `${l}\n`).join(''));
    } else fail(`no store answer for filter ${jq}`);
  },
  /** gh's `--json title,body,labels,comments` on stdin → the text an agent read, with no number, URL or time. */
  'ticket-text'() {
    const t = JSON.parse(fs.readFileSync(0, 'utf8'));
    const parts = [`title: ${t.title}`, `labels: ${t.labels.map((l) => l.name).join(', ')}`, 'body:', t.body, ...t.comments.flatMap((c) => ['comment:', c.body])];
    process.stdout.write(`${parts.join('\n')}\n`);
  },
};

const [op, ...rest] = process.argv.slice(2);
if (!(op in ops)) fail(`unknown store op ${op}`);
ops[op](...rest);
