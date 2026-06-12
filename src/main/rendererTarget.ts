// Where the window loads its renderer from. The dev-server URL is honored only in
// unpackaged (dev) builds: in a packaged app, an attacker-influenced
// ELECTRON_RENDERER_URL must never redirect the PTY-writing preload bridge (§6).

export type RendererTarget = { kind: 'url'; url: string } | { kind: 'file' };

export function resolveRendererTarget(input: {
  isPackaged: boolean;
  rendererUrl?: string;
}): RendererTarget {
  if (!input.isPackaged && input.rendererUrl) return { kind: 'url', url: input.rendererUrl };
  return { kind: 'file' };
}
