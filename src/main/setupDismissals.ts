import path from 'node:path';
import type { SetupDismissal } from '../shared/setupCheck';
import { atomicWriteFileSync } from './atomicFile';
import { readBoundedNoFollow } from './boundedRead';
import { resolveOwnedDirJail } from './confinedPath';
import { errMsg } from './errno';
import { flowHomeDir } from './flowHome';

export type DismissalWrite = { ok: true } | { ok: false; error: string };

export interface SetupDismissals {
  /** Every dismissal recorded under the app-state home. */
  recorded(): SetupDismissal[];
  /** Records `dismissal`. A repository dismissal joins those already recorded; an examples dismissal replaces the
   *  one recorded for an earlier version. */
  record(dismissal: SetupDismissal): DismissalWrite;
}

/** CWE-400: the file holds repository keys and one version string; one past this is read as no dismissals. */
export const MAX_SETUP_DISMISSALS_BYTES = 1024 * 1024;

interface DismissalRecord {
  repos: string[];
  examplesVersion: string | null;
}

const NONE: DismissalRecord = { repos: [], examplesVersion: null };

const SETUP_DISMISSALS_FILE = 'setup-dismissals.json';

export function setupDismissalsFile(appHome: string): string {
  return path.join(flowHomeDir(appHome), SETUP_DISMISSALS_FILE);
}

/** The file under the app-state folder resolved through a link the operator placed there, or null when that
 *  folder cannot be reduced to a real path. */
function resolvedDismissalsFile(appHome: string): string | null {
  const dir = resolveOwnedDirJail(flowHomeDir(appHome));
  return dir === null ? null : path.join(dir, SETUP_DISMISSALS_FILE);
}

const isRecordShape = (doc: unknown): doc is { repos: unknown; examplesVersion?: unknown } =>
  typeof doc === 'object' && doc !== null && !Array.isArray(doc);

/** A file that is absent, unreadable, over the cap, or not this shape reads as no dismissals, so the warning
 *  still shows. */
function readRecord(file: string | null): DismissalRecord {
  if (file === null) return NONE;
  const read = readBoundedNoFollow(file, MAX_SETUP_DISMISSALS_BYTES);
  if (!read.ok) return NONE;
  let doc: unknown;
  try {
    doc = JSON.parse(read.text);
  } catch {
    return NONE;
  }
  if (!isRecordShape(doc) || !Array.isArray(doc.repos)) return NONE;
  const { repos, examplesVersion = null } = doc;
  if (!repos.every((key): key is string => typeof key === 'string')) return NONE;
  if (examplesVersion !== null && typeof examplesVersion !== 'string') return NONE;
  return { repos, examplesVersion };
}

function withDismissal(current: DismissalRecord, dismissal: SetupDismissal): DismissalRecord {
  if (dismissal.kind === 'examples') return { ...current, examplesVersion: dismissal.appVersion };
  if (current.repos.includes(dismissal.repoKey)) return current;
  return { ...current, repos: [...current.repos, dismissal.repoKey] };
}

export function createSetupDismissals(appHome: string): SetupDismissals {
  return {
    recorded() {
      const { repos, examplesVersion } = readRecord(resolvedDismissalsFile(appHome));
      const dismissals: SetupDismissal[] = repos.map((repoKey) => ({ kind: 'repo', repoKey }));
      if (examplesVersion !== null) dismissals.push({ kind: 'examples', appVersion: examplesVersion });
      return dismissals;
    },
    record(dismissal) {
      const file = resolvedDismissalsFile(appHome);
      if (file === null) {
        return { ok: false, error: `${flowHomeDir(appHome)} cannot be resolved to a real folder.` };
      }
      const next = withDismissal(readRecord(file), dismissal);
      try {
        if (atomicWriteFileSync(file, `${JSON.stringify(next, null, 2)}\n`)) return { ok: true };
        return { ok: false, error: `${path.dirname(file)} is not a folder.` };
      } catch (e) {
        return { ok: false, error: errMsg(e) };
      }
    },
  };
}
