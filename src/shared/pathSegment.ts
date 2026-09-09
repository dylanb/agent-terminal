// The one engine-neutral predicate for "this untrusted string is a single safe path segment". Loop names,
// phase ids, persona/actor names and artifact ids all become filesystem path components downstream, so
// repo- or def-supplied config is confined to one segment — no separators, no `.`/`..`, no leading hyphen
// (CWE-22 defense in depth). Lifted here so both loop engines share one definition and neither owns it.

const SAFE_SEGMENT = /^[a-z0-9][a-z0-9-]*$/;

/** True when `s` is a single safe path segment: lowercase alnum start, then lowercase alnum or hyphen. */
export function isSafePathSegment(s: string): boolean {
  return SAFE_SEGMENT.test(s);
}

/** §18.7.6 (CWE-20): the one shared catalog-ID length bound — A1 install, A2 resolve, and A4 seed import
 *  this single constant so the number cannot drift across slices. */
export const MAX_CATALOG_ID_LENGTH = 64;

/** §18.7.6: a flow-catalog entry id — a safe path segment within the shared length bound. The entry
 *  directory name becomes a path segment the resolver later walks, so the install and the resolver gate on
 *  this one predicate. */
export function isSafeCatalogId(s: string): boolean {
  return isSafePathSegment(s) && s.length <= MAX_CATALOG_ID_LENGTH;
}
