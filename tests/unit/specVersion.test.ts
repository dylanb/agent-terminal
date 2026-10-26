import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// The spec is the authority (CLAUDE.md), and a version tag is how a reader dates a contract: a `§6` channel
// row tagged "(vN)" claims the row's contract changed in vN, and the changelog entry for vN is where that
// change is described. A header, a changelog entry, and a row tag that disagree leave the reader unable to
// say when the contract moved — so the two version facts the document states about ITSELF are pinned here.

// The spec was split into per-section files under docs/spec/: the front-matter `Document status`
// stays on the top-level index, and the changelog moved to docs/spec/changelog.md. Both facts are still the
// document's statement ABOUT ITSELF, so each is read from wherever the split now keeps it.
const spec = readFileSync(path.join(__dirname, '../../terminal-web-ui-spec.md'), 'utf8');
const changelog = readFileSync(path.join(__dirname, '../../docs/spec/changelog.md'), 'utf8');

type Version = readonly [major: number, minor: number];
const fmt = (v: Version): string => `v${v[0]}.${v[1]}`;
const newer = (a: Version, b: Version): boolean => b[0] > a[0] || (b[0] === a[0] && b[1] > a[1]);

const changelogVersions = (): Version[] =>
  [...changelog.matchAll(/\*\*Changelog v(\d+)\.(\d+):\*\*/g)].map((m) => [Number(m[1]), Number(m[2])] as const);

const documentStatus = (): Version | null => {
  const m = spec.match(/\*\*Document status:\*\*\s+Draft v(\d+)\.(\d+)/);
  return m ? ([Number(m[1]), Number(m[2])] as const) : null;
};

describe('the spec dates its own contract consistently', () => {
  it('states a document status and at least one changelog entry', () => {
    expect(documentStatus()).not.toBeNull();
    expect(changelogVersions().length).toBeGreaterThan(0);
  });

  it('the document status names the newest changelog entry', () => {
    const versions = changelogVersions();
    const newest = versions.reduce((a, b) => (newer(a, b) ? b : a));
    const status = documentStatus() as Version;
    expect(fmt(status)).toBe(fmt(newest));
  });

  it('no changelog entry is dated ahead of the document status', () => {
    const status = documentStatus() as Version;
    for (const v of changelogVersions()) expect(newer(status, v)).toBe(false);
  });
});
