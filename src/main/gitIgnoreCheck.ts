export type IgnoreAnswer = 'ignored' | 'not-ignored' | 'unknown';

export function agentTerminalIgnored(_repoDir: string): Promise<IgnoreAnswer> {
  return Promise.reject(new Error('agentTerminalIgnored is not built yet'));
}
