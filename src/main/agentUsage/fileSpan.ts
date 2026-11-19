/** A log file's span: from its creation time to its last-modified time, in milliseconds. */
export interface Span {
  from: number;
  to: number;
}

/** A file's times as the system reports them; a time it does not report is absent or 0. */
export interface FileTimes {
  created?: number;
  modified?: number;
}

const reported = (time: number | undefined): time is number => time !== undefined && Number.isFinite(time) && time > 0;

/** A copy can keep a last-modified time older than its creation, so the span runs from the earlier to the later. */
export function fileSpan({ created, modified }: FileTimes): Span | 'times-unreadable' {
  if (!reported(created) || !reported(modified)) return 'times-unreadable';
  return { from: Math.min(created, modified), to: Math.max(created, modified) };
}
