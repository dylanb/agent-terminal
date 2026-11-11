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

export const effectiveLinuxDesktopFileName = (config: ResolvedConfig): string => {
  const executableName = effectiveLinuxExecutableName(config);
  if (config.linux?.syncDesktopName !== true) return executableName;
  const root = path.resolve(__dirname, '..', '..');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { desktopName?: string };
  const desktopName = ((config.extraMetadata?.desktopName ?? pkg.desktopName) as string | undefined)?.trim();
  if (desktopName == null || desktopName === '') return executableName;
  return desktopName.replace(/\.desktop$/, '');
};
