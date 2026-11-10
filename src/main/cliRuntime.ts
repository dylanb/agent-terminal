import { appImageFactsFromEnv } from './appImageFacts';
import type { RuntimeInfo } from './cliInstall';
import { resolveLaunchInvocation } from './cliShim';
import { resolveShellPath } from './pty';

export interface CliHost {
  env: NodeJS.ProcessEnv;
  home: string;
  user: { uid: number; shell: string | null };
  execPath: string;
  isDevBuild: boolean;
  mainScript: string | undefined;
  cwd: string;
}

export function cliRuntime(host: CliHost): RuntimeInfo {
  return {
    home: host.home,
    shell: resolveShellPath(host.env, host.user.shell ?? undefined),
    currentPath: host.env.PATH ?? '',
    invocation: resolveLaunchInvocation(host.execPath, host.isDevBuild, host.mainScript, host.cwd, appImageFactsFromEnv(host.env)),
    uid: host.user.uid,
  };
}
