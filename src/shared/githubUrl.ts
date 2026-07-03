// The open-external allow-list (CWE-601), shared by the main-process OS-open sink and the renderer's
// <a href> sink so the two sides cannot drift on what counts as a safe GitHub url (CLAUDE.md
// shared-semantics: anything both processes must agree on lives in src/shared/).

/** The NORMALIZED https GitHub href to hand a sink, or null for any non-https / non-GitHub /
 *  unparseable input. Returning the parsed `href` (not a boolean) closes the validator-sink parser
 *  differential: the caller opens exactly the string that was validated, never the raw input a more
 *  permissive OS handler might re-parse (e.g. an embedded tab the WHATWG parser strips). */
export function githubHttpsHref(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:') return null;
  if (u.hostname !== 'github.com' && !u.hostname.endsWith('.github.com')) return null;
  return u.href;
}

/** The trailing issue/PR number of a `gh` CLI/API url (e.g. `…/issues/25` → 25), or null when the url
 *  carries no trailing number. One definition for every `gh …` stdout parser (pickup PR create, issue
 *  create) so the callers cannot drift on what "the number gh printed" means. */
export function numberFromGithubUrl(url: string): number | null {
  const m = url.trim().match(/\/(\d+)\s*$/);
  return m ? Number(m[1]) : null;
}
