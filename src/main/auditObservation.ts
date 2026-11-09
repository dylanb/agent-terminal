import { errMsg } from './errno';

export function createAuditObservation(deps: { observe(): Promise<void>; cancel(): void }): {
  observe(): Promise<void>;
  close(): Promise<void>;
} {
  const pending = new Set<Promise<void>>();
  const failures = new Set<string>();
  const report = (error: unknown): void => {
    const reason = errMsg(error);
    if (!failures.has(reason)) {
      failures.add(reason);
      console.error(`Audit observation failed: ${reason}`);
    }
  };
  const observe = (): Promise<void> => {
    let work: Promise<void>;
    try { work = deps.observe(); } catch (error) { report(error); return Promise.resolve(); }
    const settled = work.then(() => { failures.clear(); }, report).finally(() => { pending.delete(settled); });
    pending.add(settled);
    return settled;
  };
  return {
    observe,
    async close() {
      void observe();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<void>(resolve => {
        timeout = setTimeout(() => {
          try { deps.cancel(); } catch (error) { report(error); }
          resolve();
        }, 1000);
      });
      try { await Promise.race([Promise.all([...pending]), deadline]); }
      finally { clearTimeout(timeout); }
    },
  };
}
