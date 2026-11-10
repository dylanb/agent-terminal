// Repo-scoped todo store (§16.3 / §16.4). A missing/corrupt file degrades to an empty list (never
// a throw) so a bad file can't wedge the pane. Done is capped (APP_MAX_DONE_TODOS).

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { atomicWriteFileSync } from './atomicFile';
import { readBoundedResolved } from './boundedRead';
import type { TodoItem, TodoSource, TodoStatus } from '../shared/ipc';

export const MAX_TODOS_FILE_BYTES = 1024 * 1024;

export interface TodoStoreDeps {
  maxDoneTodos: number;
  now?: () => number;
  newId?: () => string;
  /** Override the on-disk file for a repo key (defaults to <repoKey>/.agent-terminal/todos.json). */
  fileFor?: (repoKey: string) => string;
}

export interface TodoStore {
  list(repoKey: string): TodoItem[];
  add(repoKey: string, text: string, source?: TodoSource): TodoItem[];
  update(repoKey: string, id: string, text: string): TodoItem[];
  reorder(repoKey: string, orderedIds: string[]): TodoItem[];
  setStatus(repoKey: string, id: string, status: TodoStatus): TodoItem[];
  delete(repoKey: string, id: string): TodoItem[];
  /** Remove every todo for the repo regardless of state or origin (#26 AC7); returns the empty list. */
  clear(repoKey: string): TodoItem[];
}

interface RepoState {
  items: TodoItem[];
  seq: number;
}

function defaultFileFor(repoKey: string): string {
  return path.join(repoKey, '.agent-terminal', 'todos.json');
}

/** All items sorted by `order`; callers split active/done by status (§16.3). */
function sorted(items: TodoItem[]): TodoItem[] {
  return [...items].sort((a, b) => a.order - b.order);
}

export function createTodoStore(deps: TodoStoreDeps): TodoStore {
  const now = deps.now ?? Date.now;
  const newId = deps.newId ?? randomUUID;
  const fileFor = deps.fileFor ?? defaultFileFor;
  const cache = new Map<string, RepoState>();

  function load(repoKey: string): RepoState {
    const cached = cache.get(repoKey);
    if (cached) return cached;
    let items: TodoItem[] = [];
    const read = readBoundedResolved(fileFor(repoKey), MAX_TODOS_FILE_BYTES);
    if (read.ok) {
      try {
        const raw = JSON.parse(read.text);
        if (Array.isArray(raw)) items = raw as TodoItem[];
      } catch {
        items = [];
      }
    }
    // The file IS the bucket (§16.3): an item belongs to the repo whose file it lives in. A
    // stale stamp (dir copied between checkouts / worktree seeded from another) would misroute
    // the renderer's per-item mutations to a foreign file; re-stamp on load so every item the
    // store hands out — and persists back — names this repo. Self-heals on the next write.
    for (const t of items) t.repoKey = repoKey;
    const seq = items.reduce((max, t) => Math.max(max, t.order), 0);
    const state: RepoState = { items, seq };
    cache.set(repoKey, state);
    return state;
  }

  function persist(repoKey: string, state: RepoState): TodoItem[] {
    atomicWriteFileSync(fileFor(repoKey), JSON.stringify(state.items));
    return sorted(state.items);
  }

  function pruneDone(state: RepoState): void {
    const done = state.items.filter((t) => t.status === 'done').sort((a, b) => a.order - b.order);
    const excess = done.length - deps.maxDoneTodos;
    if (excess <= 0) return;
    const drop = new Set(done.slice(0, excess).map((t) => t.id));
    state.items = state.items.filter((t) => !drop.has(t.id));
  }

  return {
    list(repoKey) {
      return sorted(load(repoKey).items);
    },
    add(repoKey, text, source) {
      const state = load(repoKey);
      state.items.push({
        id: newId(),
        repoKey,
        text,
        status: 'active',
        order: ++state.seq,
        createdAt: new Date(now()).toISOString(),
        ...(source ? { source } : {}),
      });
      return persist(repoKey, state);
    },
    update(repoKey, id, text) {
      const state = load(repoKey);
      const item = state.items.find((t) => t.id === id);
      if (item) item.text = text;
      return persist(repoKey, state);
    },
    reorder(repoKey, orderedIds) {
      const state = load(repoKey);
      for (const id of orderedIds) {
        const item = state.items.find((t) => t.id === id);
        if (item) item.order = ++state.seq;
      }
      return persist(repoKey, state);
    },
    setStatus(repoKey, id, status) {
      const state = load(repoKey);
      const item = state.items.find((t) => t.id === id);
      if (item) {
        item.status = status;
        // A status change never reorders — checking/unchecking keeps the row in place (§16.3).
        if (status === 'done') pruneDone(state);
      }
      return persist(repoKey, state);
    },
    delete(repoKey, id) {
      const state = load(repoKey);
      state.items = state.items.filter((t) => t.id !== id);
      return persist(repoKey, state);
    },
    clear(repoKey) {
      const state = load(repoKey);
      state.items = [];
      return persist(repoKey, state);
    },
  };
}
