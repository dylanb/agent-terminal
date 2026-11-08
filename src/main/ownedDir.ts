import { lstat, mkdir } from 'node:fs/promises';

/** Creates `directory` when missing and answers whether it is a real directory the current user owns and only they
 *  can enter, so a socket placed in it is reachable by no other user. */
export async function preparePrivateDir(directory: string): Promise<boolean> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  return stat.isDirectory() && stat.uid === process.getuid?.() && (stat.mode & 0o777) === 0o700;
}
