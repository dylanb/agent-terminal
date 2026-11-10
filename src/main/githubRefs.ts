// Best-effort GitHub ref resolver (§24.2.3 T7). NEVER throws: a missing `gh`, a non-GitHub repo, an
// offline machine, or a malformed response all degrade to null, so the popout falls back to the bare
// number. The open-external allow-list lives in src/shared/githubUrl.ts; the renderer validates a ref
// url through it before the OS opens it.

import { execFile } from 'node:child_process';
import type { GithubRef, GithubRefKind } from '../shared/ipc';
import { displayGitHubRepository } from './githubRepository';

/** The `gh` sub-command + args that emit a ref's title/body/url as JSON, from the repository `selector` names
 *  (`<host>/<owner>/<name>`). */
export function ghArgs(kind: GithubRefKind, number: number, selector: string): string[] {
  return [kind, 'view', String(number), '--repo', selector, '--json', 'title,body,url'];
}

/** Parse `gh ... --json` output into a ref, or null for null/non-JSON/ill-typed input (never throws). */
export function parseGithubRef(raw: string | null): GithubRef | null {
  if (raw === null) return null;
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof doc !== 'object' || doc === null) return null;
  const { title, body, url } = doc as Record<string, unknown>;
  if (typeof title !== 'string' || typeof body !== 'string' || typeof url !== 'string') return null;
  return { title, body, url };
}

const GH_TIMEOUT_MS = 5000;

async function runGh(repoKey: string, kind: GithubRefKind, number: number): Promise<string | null> {
  let selector: string;
  try {
    selector = (await displayGitHubRepository(repoKey)).selector;
  } catch {
    return null;
  }
  return new Promise((resolve) => {
    execFile('gh', ghArgs(kind, number, selector), { cwd: repoKey, timeout: GH_TIMEOUT_MS }, (err, stdout) => {
      resolve(err ? null : stdout);
    });
  });
}

/** Resolve a GitHub ref's detail (§24.2.3 T7); null when unresolvable. */
export type GithubRefFetcher = (repoKey: string, kind: GithubRefKind, number: number) => Promise<GithubRef | null>;

export interface GithubRefsDeps {
  /** Fetch a ref's raw `gh --json` document text, or null when it can't be resolved. The default
   *  shells out to `gh`; tests inject a fake to exercise caching/parsing without gh or a network. */
  fetchRaw?: (repoKey: string, kind: GithubRefKind, number: number) => Promise<string | null>;
}

/** Build a ref fetcher that caches successes for the process lifetime, keyed by (repo, kind, number).
 *  A failure is never cached, so a transient outage doesn't permanently blank the popout. */
export function createGithubRefs(deps: GithubRefsDeps = {}): GithubRefFetcher {
  const fetchRaw = deps.fetchRaw ?? runGh;
  const cache = new Map<string, Promise<GithubRef | null>>();
  return (repoKey, kind, number) => {
    const key = `${repoKey}\0${kind}\0${number}`;
    const hit = cache.get(key);
    if (hit) return hit;
    const p = fetchRaw(repoKey, kind, number)
      .then(parseGithubRef)
      .catch(() => null);
    cache.set(key, p);
    // Evict an unresolved result so a later call retries rather than caching the outage forever.
    void p.then((r) => {
      if (r === null) cache.delete(key);
    });
    return p;
  };
}
