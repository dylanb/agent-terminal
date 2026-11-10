import { execFileSync } from 'node:child_process';

export function typeAtDesktop(command: string, env: NodeJS.ProcessEnv): void {
  if (process.platform === 'linux') {
    execFileSync('xdotool', ['type', '--clearmodifiers', '--delay', '1', command], { env });
    execFileSync('xdotool', ['key', 'Return'], { env });
  } else {
    execFileSync('osascript', ['-e', 'on run argv\ntell application "System Events"\nkeystroke (item 1 of argv)\nkey code 36\nend tell\nend run', command]);
  }
}
