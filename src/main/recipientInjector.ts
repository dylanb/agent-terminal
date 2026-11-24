import { errMsg } from './errno';
import { createInjector, type Injector } from './inject';

export function createRecipientInjector(deps: {
  canReceive(): boolean;
  paste(data: string): void;
  write(data: string): void;
  onInject(): void;
  onDrop(reason: string): void;
}): Injector {
  return (text, opts) => {
    let active = true;
    const transfer = (write: (data: string) => void, data: string): void => {
      if (!active) return;
      try {
        if (!deps.canReceive()) throw new Error('the calling session is no longer the terminal recipient.');
        write(data);
      } catch (error) {
        active = false;
        deps.onDrop(errMsg(error));
      }
    };
    const inject = createInjector({
      paste: data => transfer(deps.paste, data),
      write: data => transfer(deps.write, data),
      onInject: () => { if (active) deps.onInject(); },
    });
    inject(text, { ...opts, onComplete: () => { if (active) opts?.onComplete?.(); } });
  };
}
