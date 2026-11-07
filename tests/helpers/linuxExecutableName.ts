import fs from 'node:fs';
import path from 'node:path';
import type { getConfig } from 'app-builder-lib/out/util/config/config';

type ResolvedConfig = Awaited<ReturnType<typeof getConfig>>;

export const effectiveLinuxExecutableName = (config: ResolvedConfig): string => {
  const configured = config.linux?.executableName ?? config.executableName;
  if (configured != null) return configured;
  const root = path.resolve(__dirname, '..', '..');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { name: string };
  return (config.extraMetadata?.name ?? pkg.name).toLowerCase();
};
