// §28.5.1 (v2.210) — the record of every test RED wrote that a later step changed, kept for the branch and read
// by the implementation approval as its `red-test-changes` input.

import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';
import { atomicWriteFileSync } from './atomicFile';
import { APP_LOOP_STATE_SCHEMA, sanitizeChangedTestPaths } from './appLoopState';
import { artifactLocation } from './loopDefV2';
import { isRecord } from './yamlRecord';

const RED_TEST_CHANGES_FILE = 'red-test-changes.yaml';
const MAX_ENTRIES = 100;

export interface RedTestChange {
  step: string;
  slice: number;
  paths: string[];
}

export interface RedTestChanges {
  branch: string;
  changes: RedTestChange[];
}

export function redTestChangesArtifact(repoDir: string): string {
  const located = artifactLocation(repoDir, RED_TEST_CHANGES_FILE);
  if (located.kind !== 'file') throw new Error(`${RED_TEST_CHANGES_FILE} cannot be placed: the loop artifacts area is unresolvable`);
  return located.path;
}

const nonBlank = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const isSlice = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1;

function toChange(raw: unknown): RedTestChange | null {
  if (!isRecord(raw) || !nonBlank(raw.step) || !isSlice(raw.slice)) return null;
  const paths = sanitizeChangedTestPaths(raw.paths);
  return paths.length > 0 ? { step: raw.step, slice: raw.slice, paths } : null;
}

export function readRedTestChanges(repoDir: string): RedTestChanges | null {
  let doc: unknown;
  try {
    doc = yaml.load(readFileSync(redTestChangesArtifact(repoDir), 'utf8'));
  } catch {
    return null;
  }
  if (!isRecord(doc) || doc.schema_version !== APP_LOOP_STATE_SCHEMA || !nonBlank(doc.branch) || !Array.isArray(doc.changes)) return null;
  const changes = doc.changes.flatMap((c) => toChange(c) ?? []).slice(0, MAX_ENTRIES);
  return { branch: doc.branch, changes };
}

export function recordRedTestChanges(repoDir: string, entry: RedTestChange & { branch: string }): void {
  const prior = readRedTestChanges(repoDir);
  const kept = prior !== null && prior.branch === entry.branch ? prior.changes.filter((c) => c.step !== entry.step || c.slice !== entry.slice) : [];
  const next = toChange(entry);
  const changes = [...kept, ...(next !== null ? [next] : [])].sort((a, b) => a.slice - b.slice).slice(0, MAX_ENTRIES);
  const file = redTestChangesArtifact(repoDir);
  if (!atomicWriteFileSync(file, yaml.dump({ schema_version: APP_LOOP_STATE_SCHEMA, branch: entry.branch, changes }), { mode: 0o644 })) {
    throw new Error(`${RED_TEST_CHANGES_FILE} could not be written: its folder is not a real directory`);
  }
}
