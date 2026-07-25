import { describe, expect, it } from 'vitest';
import { CommandFailure } from '../../src/main/appBootstrapCommand';
import {
  createOriginConfigReader,
  originUrls,
  soleOriginUrl,
  type OriginConfigReader,
} from '../../src/main/originUrl';

// The module both the repository this NAMES and the remote an operation REACHES resolve through, so the
// two cannot drift. Its rules are git's: push prefers pushurl and falls back to url, fetch never reads
// pushurl, an unset key is empty rather than an error, and a multi-valued origin has no single answer.

const reader = (values: Record<string, string[]>): OriginConfigReader => ({
  values: async (key) => values[key] ?? [],
});

describe('originUrls', () => {
  it('prefers pushurl for a push and ignores it for a fetch', async () => {
    const origin = reader({
      url: ['https://github.com/owner/repository.git'],
      pushurl: ['git@github.com:owner/repository.git'],
    });

    expect(await originUrls(origin, 'push')).toEqual([
      'git@github.com:owner/repository.git',
    ]);
    expect(await originUrls(origin, 'fetch')).toEqual([
      'https://github.com/owner/repository.git',
    ]);
  });

  it('falls back to url for a push when no pushurl is configured', async () => {
    const origin = reader({ url: ['https://github.com/owner/repository.git'] });

    expect(await originUrls(origin, 'push')).toEqual([
      'https://github.com/owner/repository.git',
    ]);
  });
});

describe('soleOriginUrl', () => {
  it('answers only when the config names exactly one URL', async () => {
    const one = reader({ url: ['https://github.com/owner/repository.git'] });
    expect(await soleOriginUrl(one, 'fetch')).toBe(
      'https://github.com/owner/repository.git',
    );

    const several = reader({
      url: [
        'https://github.com/owner/repository.git',
        'https://github.com/other/repository.git',
      ],
    });
    expect(await soleOriginUrl(several, 'fetch')).toBeNull();
    expect(await soleOriginUrl(reader({}), 'fetch')).toBeNull();
  });
});

describe('createOriginConfigReader', () => {
  it('reads every value for the key, trimmed and without blanks', async () => {
    const seen: string[][] = [];
    const origin = createOriginConfigReader(async (args) => {
      seen.push(args);
      return '  https://github.com/owner/repository.git  \n\nhttps://github.com/owner/mirror.git\n';
    });

    expect(await origin.values('pushurl')).toEqual([
      'https://github.com/owner/repository.git',
      'https://github.com/owner/mirror.git',
    ]);
    expect(seen).toEqual([['config', '--get-all', 'remote.origin.pushurl']]);
  });

  // git exits 1 for a key that is simply unset; every other code means the config could not be read, and
  // reporting that as "this repository has no origin" is how an unreadable config became a missing one.
  it('treats an unset key as empty but propagates a failure to read the config', async () => {
    const unset = createOriginConfigReader(() =>
      Promise.reject(new CommandFailure('origin resolution failed', 1)),
    );
    expect(await unset.values('url')).toEqual([]);

    const unreadable = createOriginConfigReader(() =>
      Promise.reject(new CommandFailure('origin resolution failed', 3)),
    );
    await expect(unreadable.values('url')).rejects.toThrow(
      /origin resolution failed/,
    );
  });
});
