// §27.11

import type { LogFile } from './sessionLogFiles';

export interface LogStream {
  lines(file: LogFile): AsyncGenerator<string>;
  forget(): void;
}

export function createLogStream(_chunkBytes: number): LogStream {
  return {
    async *lines(_file: LogFile): AsyncGenerator<string> {},
    forget(): void {},
  };
}
