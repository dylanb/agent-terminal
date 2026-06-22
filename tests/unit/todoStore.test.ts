import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTodoStore, type TodoStore } from '../../src/main/todoStore';

// §16.3: the store writes to <repoKey>/.agent-terminal/todos.json. Real temp dirs as repo keys, no
// fs mocks; `now`/`newId` injected for determinism.
describe('todoStore (§16.3 / §16.4 — repo-scoped CRUD + persistence)', () => {
  let repoA: string;
  let repoB: string;
  let ids: number;

  function makeStore(opts?: { maxDoneTodos?: number }): TodoStore {
    return createTodoStore({
      maxDoneTodos: opts?.maxDoneTodos ?? 50,
      now: () => 1700000000000,
      newId: () => `id-${++ids}`,
    });
  }

  beforeEach(() => {
    repoA = mkdtempSync(join(tmpdir(), 'todo-a-'));
    repoB = mkdtempSync(join(tmpdir(), 'todo-b-'));
    ids = 0;
  });
  afterEach(() => {
    rmSync(repoA, { recursive: true, force: true });
    rmSync(repoB, { recursive: true, force: true });
  });

  it('starts empty for a fresh repo', () => {
    expect(makeStore().list(repoA)).toEqual([]);
  });

  it('adds todos appended to the bottom of the active list', () => {
    const store = makeStore();
    store.add(repoA, 'first');
    const list = store.add(repoA, 'second');
    expect(list.map((t) => t.text)).toEqual(['first', 'second']);
    expect(list.every((t) => t.status === 'active')).toBe(true);
    expect(list[0].order).toBeLessThan(list[1].order);
  });

  it('scopes lists per repo key', () => {
    const store = makeStore();
    store.add(repoA, 'a-only');
    store.add(repoB, 'b-only');
    expect(store.list(repoA).map((t) => t.text)).toEqual(['a-only']);
    expect(store.list(repoB).map((t) => t.text)).toEqual(['b-only']);
  });

  it('stamps the repoKey, a createdAt, and an optional source onto an added todo', () => {
    const [item] = makeStore().add(repoA, 'task', { type: 'finding', eventId: 'e1' });
    expect(item.repoKey).toBe(repoA);
    expect(item.createdAt).toBe(new Date(1700000000000).toISOString());
    expect(item.source).toEqual({ type: 'finding', eventId: 'e1' });
  });

  it('updates a todo text in place, leaving others untouched', () => {
    const store = makeStore();
    const [a] = store.add(repoA, 'a');
    store.add(repoA, 'b');
    const list = store.update(repoA, a.id, 'a-edited');
    expect(list.find((t) => t.id === a.id)?.text).toBe('a-edited');
    expect(list.find((t) => t.text === 'b')).toBeTruthy();
  });

  it('reorders the active list and persists the new order', () => {
    const store = makeStore();
    const [a] = store.add(repoA, 'a');
    const [, b] = [a, store.add(repoA, 'b')[1]];
    const c = store.add(repoA, 'c')[2];
    const list = store.reorder(repoA, [c.id, a.id, b.id]);
    expect(list.filter((t) => t.status === 'active').map((t) => t.text)).toEqual(['c', 'a', 'b']);
  });

  it('marks a todo done, filtering it out of the active group', () => {
    const store = makeStore();
    const [a] = store.add(repoA, 'a');
    store.add(repoA, 'b');
    const list = store.setStatus(repoA, a.id, 'done');
    const active = list.filter((t) => t.status === 'active');
    const done = list.filter((t) => t.status === 'done');
    expect(active.map((t) => t.text)).toEqual(['b']);
    expect(done.map((t) => t.text)).toEqual(['a']);
  });

  it('keeps a todo in its original position when checked then unchecked (no reorder — §16.3)', () => {
    const store = makeStore();
    const [a] = store.add(repoA, 'a');
    store.add(repoA, 'b');
    store.setStatus(repoA, a.id, 'done');
    const list = store.setStatus(repoA, a.id, 'active');
    expect(list.filter((t) => t.status === 'active').map((t) => t.text)).toEqual(['a', 'b']);
  });

  it('deletes a todo', () => {
    const store = makeStore();
    const [a] = store.add(repoA, 'a');
    store.add(repoA, 'b');
    const list = store.delete(repoA, a.id);
    expect(list.map((t) => t.text)).toEqual(['b']);
  });

  it('caps the Done section, pruning the oldest done items', () => {
    const store = makeStore({ maxDoneTodos: 2 });
    const items = [store.add(repoA, '1')[0], store.add(repoA, '2')[1], store.add(repoA, '3')[2]];
    store.setStatus(repoA, items[0].id, 'done');
    store.setStatus(repoA, items[1].id, 'done');
    const list = store.setStatus(repoA, items[2].id, 'done');
    const done = list.filter((t) => t.status === 'done').map((t) => t.text);
    expect(done).not.toContain('1');
    expect(done).toEqual(['2', '3']);
  });

  // ---- persistence (§16.3) ----

  it('persists across store instances (reload / restart)', () => {
    makeStore().add(repoA, 'survive');
    ids = 0;
    expect(makeStore().list(repoA).map((t) => t.text)).toEqual(['survive']);
  });

  it('writes to <repoKey>/.agent-terminal/todos.json', () => {
    makeStore().add(repoA, 'x');
    const file = join(repoA, '.agent-terminal', 'todos.json');
    expect(JSON.parse(readFileSync(file, 'utf8')).length).toBe(1);
  });

  it('degrades a missing file to an empty list', () => {
    expect(makeStore().list(repoA)).toEqual([]);
  });

  it('degrades a corrupt file to an empty list without throwing', () => {
    mkdirSync(join(repoA, '.agent-terminal'), { recursive: true });
    writeFileSync(join(repoA, '.agent-terminal', 'todos.json'), 'not json {{{');
    expect(() => makeStore().list(repoA)).not.toThrow();
    expect(makeStore().list(repoA)).toEqual([]);
  });

  it('writes atomically — no stray temp file remains', () => {
    makeStore().add(repoA, 'x');
    const written = readdirSync(join(repoA, '.agent-terminal'));
    expect(written).toEqual(['todos.json']);
  });

  // ---- contamination resilience (§16.3): the file IS the bucket ----
  // A todos.json can carry items whose stored repoKey names a *different* repo — e.g. the
  // .agent-terminal dir was copied from another checkout, or a worktree was seeded from one.
  // An item belongs to the file it lives in; per-row mutations route by the item's own
  // repoKey, so a stale stamp sends setStatus/delete to the wrong file (the displayed list
  // appears to clear / deletions resurrect). list() must report the file's key, not the stamp.
  function seedRawFile(repo: string, items: unknown[]): void {
    mkdirSync(join(repo, '.agent-terminal'), { recursive: true });
    writeFileSync(join(repo, '.agent-terminal', 'todos.json'), JSON.stringify(items));
  }

  it('normalizes an item carrying a foreign repoKey to the file it was loaded from', () => {
    seedRawFile(repoA, [
      { id: 'x1', repoKey: repoB, text: 'carried over', status: 'active', order: 1, createdAt: '2020-01-01T00:00:00.000Z' },
    ]);
    const [item] = makeStore().list(repoA);
    expect(item.repoKey).toBe(repoA);
  });

  it('self-heals a contaminated file on the next write', () => {
    seedRawFile(repoA, [
      { id: 'x1', repoKey: repoB, text: 'carried over', status: 'active', order: 1, createdAt: '2020-01-01T00:00:00.000Z' },
    ]);
    const store = makeStore();
    store.add(repoA, 'fresh'); // any mutation persists the loaded state
    const onDisk = JSON.parse(readFileSync(join(repoA, '.agent-terminal', 'todos.json'), 'utf8')) as { repoKey: string }[];
    expect(onDisk.every((t) => t.repoKey === repoA)).toBe(true);
  });
});
