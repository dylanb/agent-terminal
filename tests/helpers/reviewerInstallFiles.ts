import { readFileSync, statSync, utimesSync } from 'node:fs';
import { shellQuote } from '../../src/shared/shellQuote';

export function ageInstalledReviewers(files: readonly string[]): void {
  for (const file of files) utimesSync(file, 946684800, 946684800);
}

export function installedReviewerSnapshot(files: readonly string[]): Record<string, { bytes: string; mtimeMs: number }> {
  return Object.fromEntries(files.map((file) => [file, {
    bytes: readFileSync(file).toString('base64'),
    mtimeMs: statSync(file).mtimeMs,
  }]));
}

export function limitedInstallCommand(command: string, args: readonly string[], kibibytes: number): string {
  if (!Number.isSafeInteger(kibibytes) || kibibytes < 1) throw new Error('the file-size limit must be positive whole KiB');
  return `ulimit -f ${kibibytes} || exit 1; trap '' XFSZ; exec ${[command, ...args].map(shellQuote).join(' ')}`;
}

export function completedReviewerWrites(output: string): string[] {
  return output.split(/\r?\n/).map((line) => line.trim())
    .filter((line) => /^(?:created|replaced):/.test(line)).sort();
}
