// §B.5 item 6 / §B.13a — a transient notice produced after a transition reply was already sent rides the next
// `flow:state` response for its repo, exactly once. Keyed by repoKey; the receiver never re-derives the target.

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
