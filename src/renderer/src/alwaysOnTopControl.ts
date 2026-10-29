import { CONTROLLER_DEFAULT_ALWAYS_ON_TOP, type ControllerApi } from '../../shared/ipc';
import { createSwitch, type Switch } from './switch';

export interface AlwaysOnTopControlDeps {
  controller: Pick<ControllerApi, 'getAlwaysOnTop' | 'setAlwaysOnTop' | 'onAlwaysOnTopChanged'>;
}

export function createAlwaysOnTopControl(host: HTMLElement, deps: AlwaysOnTopControlDeps): { dispose(): void } {
  let disposed = false;
  let control: Switch | undefined;
  let reported: boolean | undefined;
  const show = (alwaysOnTop: boolean) => {
    reported = alwaysOnTop;
    if (!disposed) control?.set(alwaysOnTop);
  };
  const unsubscribe = deps.controller.onAlwaysOnTopChanged(show);
  void deps.controller.getAlwaysOnTop().catch(() => CONTROLLER_DEFAULT_ALWAYS_ON_TOP).then(initial => {
    if (disposed) return;
    const shown = reported ?? initial;
    reported = shown;
    control = createSwitch(host, {
      label: 'Always on top',
      checked: shown,
      onChange(next) {
        return deps.controller.setAlwaysOnTop(next).then(show, error => {
          console.error(`Controller always on top not set: ${error instanceof Error ? error.message : String(error)}`);
          show(reported ?? shown);
        });
      },
    });
  });
  return {
    dispose() {
      disposed = true;
      unsubscribe();
      control?.dispose();
    },
  };
}
