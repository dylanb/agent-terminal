import { describe, it, expect } from 'vitest';
import { createFeed, createScriptedAsync, deferred } from '../helpers/scriptedCalls';

// A3 (#134) — proven here so an organism test's timing claims rest on a fake that really holds an answer back.
describe('scripted calls kit (A3 #134)', () => {
  it('deferred settles its promise only when the test resolves or rejects it', async () => {
    const d = deferred<number>();
    let seen: number | undefined;
    void d.promise.then((v) => (seen = v));
    await Promise.resolve();
    expect(seen).toBeUndefined();
    d.resolve(7);
    await d.promise;
    expect(seen).toBe(7);

    const r = deferred<number>();
    r.reject(new Error('boom'));
    await expect(r.promise).rejects.toThrow('boom');
  });

  it('answers each call from its queue in order and records the arguments', async () => {
    const fn = createScriptedAsync<[string, string], { ok: boolean }>();
    fn.respond({ ok: true });
    fn.respond({ ok: false });

    expect(await fn.call('repo-a', 'x')).toEqual({ ok: true });
    expect(await fn.call('repo-a', 'y')).toEqual({ ok: false });
    expect(fn.calls()).toEqual([
      ['repo-a', 'x'],
      ['repo-a', 'y'],
    ]);
  });

  it('holds a respondLater answer back until the test resolves it', async () => {
    const fn = createScriptedAsync<[string], string>();
    const later = fn.respondLater();
    let seen: string | undefined;
    void fn.call('repo-a').then((v) => (seen = v));
    await Promise.resolve();
    expect(seen).toBeUndefined();
    later.resolve('listing-a');
    await later.promise;
    await Promise.resolve();
    expect(seen).toBe('listing-a');
  });

  it('falls back to the otherwise answer once the queue is empty', async () => {
    const fn = createScriptedAsync<[string], string>();
    fn.respond('first');
    fn.otherwise('rest');
    expect(await fn.call('a')).toBe('first');
    expect(await fn.call('b')).toBe('rest');
    expect(await fn.call('c')).toBe('rest');
  });

  it('rejects a call nothing was scripted for, as an async service would, and records it for the test to check', async () => {
    const fn = createScriptedAsync<[string], string>();
    const answer = fn.call('a');
    expect(answer).toBeInstanceOf(Promise);
    await expect(answer).rejects.toThrow(/unscripted/);
    expect(fn.calls()).toEqual([['a']]);
    expect(fn.unscripted()).toEqual([['a']]);
  });

  it('records no unscripted call when every call was answered', async () => {
    const fn = createScriptedAsync<[string], string>();
    fn.respond('x');
    await fn.call('a');
    expect(fn.unscripted()).toEqual([]);
  });

  it('a feed delivers each fire to every subscriber until it unsubscribes', () => {
    const feed = createFeed<[string | null, number | null]>();
    const a: unknown[] = [];
    const b: unknown[] = [];
    const offA = feed.subscribe((k, v) => a.push([k, v]));
    feed.subscribe((k, v) => b.push([k, v]));
    expect(feed.listeners()).toBe(2);

    feed.fire('repo-a', 1);
    offA();
    feed.fire(null, null);

    expect(a).toEqual([['repo-a', 1]]);
    expect(b).toEqual([
      ['repo-a', 1],
      [null, null],
    ]);
    expect(feed.listeners()).toBe(1);
  });
});
