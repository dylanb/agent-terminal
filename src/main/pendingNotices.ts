// §B.5 item 6 / §B.13a

export interface PendingNotices {
  post(repoKey: string, text: string): void;
  /** The repo's pending notice, consumed: a second take returns undefined. */
  take(repoKey: string): string | undefined;
}

export function createPendingNotices(): PendingNotices {
  const pending = new Map<string, string>();
  return {
    post: (repoKey, text) => {
      pending.set(repoKey, text);
    },
    take: (repoKey) => {
      const text = pending.get(repoKey);
      pending.delete(repoKey);
      return text;
    },
  };
}
