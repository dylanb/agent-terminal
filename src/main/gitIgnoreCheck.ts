import { CommandFailure, run } from './appBootstrapCommand';
import { coreExecHardeningArgs, freshDisabledHooksDir } from './gitHardening';

export type IgnoreAnswer = 'ignored' | 'not-ignored' | 'unknown';

/** Git's own verdict on whether its ignore rules cover the whole `.agent-terminal/` folder of `repoDir`. Exit 0
 *  of `git check-ignore` means ignored and exit 1 means not ignored; any other exit, a spawn failure or a
 *  timeout means git could not answer, which never reads as ignored. */
export async function agentTerminalIgnored(repoDir: string): Promise<IgnoreAnswer> {
  const args = [...coreExecHardeningArgs(freshDisabledHooksDir()), 'check-ignore', '-q', '--', '.agent-terminal/'];
  try {
    await run('git', args, repoDir, 'git check-ignore failed');
    return 'ignored';
  } catch (e: unknown) {
    return e instanceof CommandFailure && e.exitCode === 1 ? 'not-ignored' : 'unknown';
  }
}
