import { CommandFailure } from './appBootstrapCommand';

/** Origin's configured URLs, read from config rather than `git remote get-url` — the latter applies
 *  url.*.insteadOf, so it names one repository while the operation reaches another (§27.10). The read,
 *  the pushurl-then-url fallback and the single-value rule are git's own and live here together, so the
 *  repository this NAMES and the remote an operation REACHES cannot be resolved by rules that drift. */
export interface OriginConfigReader {
  /** Every configured value for `remote.origin.<key>`, empty when the key is unset. */
  values(key: 'url' | 'pushurl'): Promise<string[]>;
}

export type OriginDirection = 'fetch' | 'push';

/** `runGit` supplies the invocation each caller owns — the in-repo runner carries neutralizing `-c`
 *  arguments the identity lookup does not — while an unset key (git exits 1) means the same on both. */
export function createOriginConfigReader(
  runGit: (args: string[]) => Promise<string>,
): OriginConfigReader {
  return {
    values: async (key) => {
      try {
        return (await runGit(['config', '--get-all', `remote.origin.${key}`]))
          .split('\n')
          .map((value) => value.trim())
          .filter((value) => value.length > 0);
      } catch (e) {
        if (e instanceof CommandFailure && e.exitCode === 1) return [];
        throw e;
      }
    },
  };
}

export async function originUrls(
  reader: OriginConfigReader,
  direction: OriginDirection,
): Promise<string[]> {
  if (direction === 'push') {
    const pushUrls = await reader.values('pushurl');
    if (pushUrls.length > 0) return pushUrls;
  }
  return reader.values('url');
}

/** The one configured origin URL for `direction`, or null when the config names none or several. A
 *  multi-valued origin has no single answer, and callers that pick different elements of the list are
 *  indistinguishable from callers that agree until it holds two. */
export async function soleOriginUrl(
  reader: OriginConfigReader,
  direction: OriginDirection,
): Promise<string | null> {
  const urls = await originUrls(reader, direction);
  return urls.length === 1 ? (urls[0] ?? null) : null;
}
