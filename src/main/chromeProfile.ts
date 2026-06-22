// Chrome profile store (§15.x). Only learned additions are persisted, never the seed —
// so a later seed change can't fossilize an old copy. A corrupt file MUST degrade to the
// seed, never throw: a bad profile can't be allowed to wedge the scanner.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { DEFAULT_CHROME_MARKERS } from './chrome';

export interface ChromeProfileStore {
  /** The active marker set: seeded defaults ∪ learned additions, deduped. */
  markers(): readonly string[];
  /** Add markers, persist, and return the new active set. */
  learn(markers: readonly string[]): readonly string[];
}

function loadLearned(filePath: string): string[] {
  try {
    const raw: unknown = JSON.parse(readFileSync(filePath, 'utf8'));
    if (!Array.isArray(raw)) return [];
    return raw.filter((m): m is string => typeof m === 'string' && m.trim() !== '');
  } catch {
    return [];
  }
}

function persist(filePath: string, learned: string[]): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  writeFileSync(tmp, JSON.stringify(learned));
  renameSync(tmp, filePath);
}

export function createChromeProfileStore(filePath: string): ChromeProfileStore {
  const learned = new Set(loadLearned(filePath));
  const active = (): string[] => [...new Set([...DEFAULT_CHROME_MARKERS, ...learned])];
  return {
    markers: active,
    learn: (incoming) => {
      for (const m of incoming) if (m.trim() !== '') learned.add(m);
      persist(filePath, [...learned]);
      return active();
    },
  };
}
