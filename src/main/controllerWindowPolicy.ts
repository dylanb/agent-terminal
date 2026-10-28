export type ControllerCloseAction = 'hide' | 'minimize';

export function controllerCloseAction(_platform: NodeJS.Platform): ControllerCloseAction {
  return 'minimize';
}
