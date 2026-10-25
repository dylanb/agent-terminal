export const ONE_COLUMN_BELOW_PX = 640;

export interface ControllerLayout {
  oneColumn(): boolean;
  onChange(listener: () => void): () => void;
}

export function createViewportLayout(view: Window): ControllerLayout {
  void view;
  return { oneColumn: () => false, onChange: () => () => {} };
}
