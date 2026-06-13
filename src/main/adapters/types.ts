// Adapter contract (§15.3 / D5/D6). An adapter inspects a scan window over the
// shadow's public read path and returns detected regions; the scanner dedups and
// emits them. Adapters assert on observable buffer text only — never on internal
// parser state — so a behavior-preserving refactor of the shadow can't break them.

import type { MonitorEventSource, MonitorEventType } from '../../shared/ipc';
import type { ShadowReader } from '../shadow';
import type { CommandSpanRange } from '../spanTypes';

export interface AdapterContext {
  reader: ShadowReader;
  /** Inclusive absolute scan window. */
  startRow: number;
  endRow: number;
  altScreen: boolean;
  /** Output ranges of finished commands, for generic span-gating (§15.6). */
  closedSpans: CommandSpanRange[];
  /** Minimum report size (chars) before a `report` is emitted (§15.3 / §15.7). */
  reportMinChars: number;
}

/** A finding inside a report — emitted as a child event linked by parentId (§15.6 / v2.6). */
export interface DetectedChild {
  type: MonitorEventType;
  source: MonitorEventSource;
  text: string;
}

export interface DetectedRegion {
  type: MonitorEventType;
  source: MonitorEventSource;
  text: string;
  startRow: number;
  endRow: number;
  /** Sub-events (report findings) emitted with parentId set to this region's id. */
  children?: DetectedChild[];
}

export interface Adapter {
  id: string;
  /** Fingerprint over observable buffer state; omitted ⇒ always selected (§15.3). */
  matches?(ctx: AdapterContext): boolean;
  detect(ctx: AdapterContext): DetectedRegion[];
}
