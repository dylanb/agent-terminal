import path from 'node:path';

export function layoutRoot(layout: (root: string) => string, dir: string): string | null {
  const probe = path.resolve(path.sep, 'layout-probe');
  const depth = path.relative(probe, layout(probe)).split(path.sep).length;
  let root = dir;
  for (let i = 0; i < depth; i++) root = path.dirname(root);
  return layout(root) === dir ? root : null;
}
