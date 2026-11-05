#!/usr/bin/env node
// sync.mjs — track and report changes pulled in from a related repository (a "sync source").
//
// Each source has a record in sync/<source>.json:
//   remote    the git remote name the source is fetched through
//   branch    the source branch synced from
//   url       the source's clone URL, for a source whose location may be public, OR
//   urlEnv    the name of an env var holding the clone URL, for a source whose location must stay private.
//             Locally the var comes from the repo-root .env (gitignored); in Actions, from a repository secret.
//   lastSync  { commit, syncedAt }: the last source commit pulled in, and the date it was pulled.
// A URL read from urlEnv is never printed: the report command's output lands in public Actions logs.
//
// Usage:
//   node scripts/sync.mjs list                       every source and its last sync
//   node scripts/sync.mjs status <source>            fetch; list the commits and files since the last sync
//   node scripts/sync.mjs record <source> [ref]      set lastSync to <ref> (default <remote>/<branch>) and today
//   node scripts/sync.mjs report                     fetch every configured source; Markdown commit counts only
//
// See docs/sync.md for the sync procedure.

import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const syncDir = join(root, 'sync')

try {
  process.loadEnvFile(join(root, '.env'))
} catch (e) {
  if (e?.code !== 'ENOENT') throw e
}

const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()

const recordPath = (source) => join(syncDir, `${source}.json`)

function sources() {
  return readdirSync(syncDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -'.json'.length))
    .sort()
}

function readRecord(source) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(source ?? '')) usage(`invalid source name: ${source}`)
  let rec
  try {
    rec = JSON.parse(readFileSync(recordPath(source), 'utf8'))
  } catch (e) {
    if (e?.code === 'ENOENT') usage(`no sync record sync/${source}.json (sources: ${sources().join(', ')})`)
    throw e
  }
  if (!rec.remote || !rec.branch) throw new Error(`sync/${source}.json: remote and branch are required`)
  if (Boolean(rec.url) === Boolean(rec.urlEnv)) {
    throw new Error(`sync/${source}.json: exactly one of url or urlEnv is required`)
  }
  return rec
}

// Returns false when the remote does not exist and no URL is configured for it.
function fetchSource(source, rec) {
  const hasRemote = git('remote').split('\n').includes(rec.remote)
  const url = rec.url ?? process.env[rec.urlEnv]
  if (!hasRemote && !url) return false
  const run = rec.urlEnv ? privateGit(source, rec) : git
  if (!hasRemote) run('remote', 'add', rec.remote, url)
  run('fetch', '--quiet', rec.remote, rec.branch)
  return true
}

// git's diagnostics name the URL with its credentials stripped, which no longer matches the masked secret.
const privateGit = (source, rec) => (...args) => {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim()
  } catch {
    console.error(`sync/${source}.json: git ${args[0]} failed for remote "${rec.remote}"; check ${rec.urlEnv}`)
    process.exit(1)
  }
}

function notConfigured(source, rec) {
  return `sync/${source}.json: no git remote "${rec.remote}" and ${rec.urlEnv} is not set (add it to .env)`
}

const sourceRef = (rec) => `${rec.remote}/${rec.branch}`
// Excludes HEAD: a source that merged commits back from this repo has them too, and they need no pulling.
const pendingRange = (rec) => [rec.lastSync?.commit ? `${rec.lastSync.commit}..${sourceRef(rec)}` : sourceRef(rec), '^HEAD']

function list() {
  for (const source of sources()) {
    const rec = readRecord(source)
    console.log(`${source}: ${rec.lastSync?.commit ?? '(never synced)'} on ${rec.lastSync?.syncedAt ?? '-'}`)
  }
}

function status(source) {
  const rec = readRecord(source)
  if (!fetchSource(source, rec)) usage(notConfigured(source, rec))
  console.log(`source:    ${source} (${sourceRef(rec)})`)
  console.log(`last sync: ${rec.lastSync?.commit ?? '(never)'} on ${rec.lastSync?.syncedAt ?? '-'}`)
  const pending = git('log', '--oneline', '--no-decorate', ...pendingRange(rec))
  if (!pending) {
    console.log('up to date: no source commits since the last sync')
    return
  }
  console.log(`\n${pending.split('\n').length} source commit(s) since the last sync:\n${pending}`)
  if (rec.lastSync?.commit) console.log(`\nfiles changed:\n${git('diff', '--stat', rec.lastSync.commit, sourceRef(rec))}`)
}

function record(source, ref) {
  const rec = readRecord(source)
  const target = ref ?? sourceRef(rec)
  const commit = git('rev-parse', '--verify', `${target}^{commit}`)
  rec.lastSync = { commit, syncedAt: new Date().toISOString().slice(0, 10) }
  writeFileSync(recordPath(source), `${JSON.stringify(rec, null, 2)}\n`)
  console.log(`recorded sync of ${commit} (${target}) from ${source} on ${rec.lastSync.syncedAt}`)
}

function report() {
  console.log('## Sync sources\n')
  for (const source of sources()) {
    const rec = readRecord(source)
    if (!fetchSource(source, rec)) {
      console.log(`- **${source}**: not configured here (no \`${rec.urlEnv}\` secret)`)
      continue
    }
    const count = Number(git('rev-list', '--count', ...pendingRange(rec)))
    const since = rec.lastSync?.syncedAt ? ` since the sync on ${rec.lastSync.syncedAt}` : ''
    console.log(`- **${source}**: ${count} commit(s) to pull in${since}`)
  }
}

function usage(message) {
  if (message) console.error(message)
  console.error('usage: node scripts/sync.mjs list | status <source> | record <source> [ref] | report')
  process.exit(2)
}

const [cmd, source, ref] = process.argv.slice(2)
if (cmd === 'list') list()
else if (cmd === 'status') status(source)
else if (cmd === 'record') record(source, ref)
else if (cmd === 'report') report()
else usage()
