import { describe, expect, it } from 'vitest';
import { ensureGithubLabel, type PinnedGh } from '../../src/main/githubLabel';

/** A `gh` whose label listing prints `listing`, recording every call. */
function ghListing(listing: string): { gh: PinnedGh; calls: string[][] } {
  const calls: string[][] = [];
  const gh: PinnedGh = async (args) => {
    calls.push(args);
    return args[1] === 'list' ? listing : '';
  };
  return { gh, calls };
}

describe('ensureGithubLabel', () => {
  it.each([
    ['is not JSON', 'not json'],
    ['is JSON but not a list', '{"name":"bench-run"}'],
  ])('rejects, creating no label, when the label listing %s', async (_case, listing) => {
    const { gh, calls } = ghListing(listing);

    const failure = await ensureGithubLabel(gh, 'bench-run').then(
      () => null,
      (e: unknown) => (e instanceof Error ? e.message : String(e)),
    );

    expect({ failure, creates: calls.filter((c) => c[1] === 'create') }).toEqual({ failure: 'label lookup failed: the label listing was not recognized', creates: [] });
  });
});
