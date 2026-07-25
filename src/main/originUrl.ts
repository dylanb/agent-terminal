/** Origin's configured URLs, read from config rather than `git remote get-url` — the latter applies
 *  url.*.insteadOf, so it names one repository while the operation reaches another (§27.10). The
 *  pushurl-then-url fallback is git's own, and lives here so the repository this NAMES and the remote
 *  an operation REACHES cannot be resolved by two rules that drift apart. */
export interface OriginConfigReader {
  /** Every configured value for `remote.origin.<key>`, empty when the key is unset. */
  values(key: 'url' | 'pushurl'): Promise<string[]>;
}

export type OriginDirection = 'fetch' | 'push';

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
