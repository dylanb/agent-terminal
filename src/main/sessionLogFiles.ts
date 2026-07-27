// §27.11

/** One session log the run's window admits: where it is, and how big it was when the walk saw it. */
export interface LogFile {
  path: string;
  /** Bytes the log held when the walk saw it; null when it would not stat. */
  size: number | null;
}

export async function* logFilesInWindow(_dir: string, _since?: number): AsyncGenerator<LogFile> {}
