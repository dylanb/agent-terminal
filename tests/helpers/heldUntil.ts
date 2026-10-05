export type AsyncSeam<I, R> = (input: I, signal?: AbortSignal) => Promise<R>;

export interface Held<I, R> {
  /** The wrapped seam to inject in place of `fn`. */
  seam: AsyncSeam<I, R>;
  /** Resolves with the input of the first call `match` accepts. */
  entered: Promise<I>;
  /** Lets the held call settle with the real outcome; harmless before `entered` or when called twice. */
  release(): void;
}

/** Wraps a real async seam so a test can act while one call of it is in flight. The first call `match`
 *  accepts runs the real `fn` at once but settles only after both `fn` has settled and `release()` was
 *  called; every other call passes straight through. */
export function heldUntil<I, R>(fn: AsyncSeam<I, R>, match: (input: I) => boolean): Held<I, R> {
  let used = false;
  let enter!: (input: I) => void;
  let release!: () => void;
  const entered = new Promise<I>((resolve) => (enter = resolve));
  const released = new Promise<void>((resolve) => (release = resolve));

  const seam: AsyncSeam<I, R> = async (input, signal) => {
    if (used || !match(input)) return fn(input, signal);
    used = true;
    enter(input);
    let call: Promise<R>;
    try {
      call = fn(input, signal);
    } catch (error: unknown) {
      call = Promise.reject(error);
    }
    const outcome = call.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    const [result] = await Promise.all([outcome, released]);
    if (result.ok) return result.value;
    throw result.error;
  };

  return { seam, entered, release };
}
