import { spawn, type ChildProcess } from 'node:child_process';
import { writeFifo } from './flowFixtures';

/** Named pipes, each with a separate process standing ready to feed it, so a reader that opens one gets its
 *  content and end of file instead of blocking. `reap()` kills every writer still running and waits for it. */
export function createFedPipes(): { at(file: string, content: string): void; reap(): Promise<void> } {
  const writers = new Set<ChildProcess>();
  return {
    at(file, content) {
      writeFifo(file);
      const writer = spawn('sh', ['-c', 'printf %s "$1" > "$2"', 'sh', content, file], { stdio: 'ignore' });
      writers.add(writer);
      writer.on('exit', () => writers.delete(writer));
    },
    async reap() {
      await Promise.all([...writers].map((w) => new Promise<void>((done) => {
        w.once('exit', () => done());
        w.kill('SIGKILL');
      })));
    },
  };
}
