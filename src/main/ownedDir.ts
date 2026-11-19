import { lstat, mkdir } from 'node:fs/promises';

export async function preparePrivateDir(directory: string): Promise<boolean> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  return stat.isDirectory() && stat.uid === process.getuid?.() && (stat.mode & 0o777) === 0o700;
}
