// Fake async services for organism DOM tests: an answer can be held back until the test settles it, so the
// test decides when, and in what order, each answer lands.

export interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export interface ScriptedAsync<A extends unknown[], R> {
  /** The fake to inject. A call no answer was scripted for rejects and is recorded in `unscripted()`. */
  call(...args: A): Promise<R>;
  /** Queue an answer for the next unanswered call. */
  respond(value: R): void;
  /** Queue an answer the test settles later, for the next unanswered call. */
  respondLater(): Deferred<R>;
  /** Answer every call made once the queue is empty. */
  otherwise(value: R): void;
  /** Every call's arguments, in call order. */
  calls(): A[];
  /** The arguments of every call that found no scripted answer, in call order. */
  unscripted(): A[];
}

export function createScriptedAsync<A extends unknown[], R>(): ScriptedAsync<A, R> {
  const queue: Deferred<R>[] = [];
  const seen: A[] = [];
  const unanswered: A[] = [];
  let fallback: { value: R } | null = null;
  return {
    call(...args) {
      seen.push(args);
      const next = queue.shift();
      if (next) return next.promise;
      if (fallback) return Promise.resolve(fallback.value);
      unanswered.push(args);
      return Promise.reject(new Error(`unscripted call with ${JSON.stringify(args)}`));
    },
    respond(value) {
      const d = deferred<R>();
      d.resolve(value);
      queue.push(d);
    },
    respondLater() {
      const d = deferred<R>();
      queue.push(d);
      return d;
    },
    otherwise(value) {
      fallback = { value };
    },
    calls: () => [...seen],
    unscripted: () => [...unanswered],
  };
}

export interface Feed<A extends unknown[]> {
  subscribe(listener: (...args: A) => void): () => void;
  fire(...args: A): void;
  listeners(): number;
}

export function createFeed<A extends unknown[]>(): Feed<A> {
  const listeners = new Set<(...args: A) => void>();
  return {
    subscribe(listener) {
      const own = (...args: A): void => listener(...args);
      listeners.add(own);
      return () => {
        listeners.delete(own);
      };
    },
    fire(...args) {
      for (const l of [...listeners]) l(...args);
    },
    listeners: () => listeners.size,
  };
}
