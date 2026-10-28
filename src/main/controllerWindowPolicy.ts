export type ControllerCloseAction = 'hide' | 'minimize';

export function controllerCloseAction(platform: NodeJS.Platform): ControllerCloseAction {
  return platform === 'darwin' ? 'hide' : 'minimize';
}
