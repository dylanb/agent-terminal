// Adapter contract (§15.3 / D5/D6). An adapter inspects a scan window over the
// shadow's public read path and returns detected regions; the scanner dedups and
// emits them. Adapters assert on observable buffer text only — never on internal
// parser state — so a behavior-preserving refactor of the shadow can't break them.

import type { MonitorEventSource, MonitorEventType } from '../../shared/ipc';
import type { ShadowReader } from '../shadow';
import type { CommandSpanRange } from '../commandTracker';

export interface AdapterContext {
  reader: ShadowReader;
  /** Inclusive absolute scan window. */
  startRow: number;
  endRow: number;
  altScreen: boolean;
  /** Output ranges of finished commands, for generic span-gating (§15.6). */
  closedSpans: CommandSpanRange[];
}

export interface DetectedRegion {
  type: MonitorEventType;
  source: MonitorEventSource;
  text: string;
  startRow: number;
  endRow: number;
}

export interface Adapter {
  id: string;
  /** Fingerprint over observable buffer state; omitted ⇒ always selected (§15.3). */
  matches?(ctx: AdapterContext): boolean;
  detect(ctx: AdapterContext): DetectedRegion[];
}
