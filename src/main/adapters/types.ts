// Adapter contract (§15.3). Invariant: a classifier can never suppress capture — at worst
// its glyphs don't match and the baseline still captures the prose.

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
  /** True when the absolute row is agent-UI chrome, never content (§15.x). */
  isChrome(row: number): boolean;
  /** True when the row was claimed by a classifier as a structured block, so the baseline
   *  excludes it (§15.3). */
  isClaimed?(row: number): boolean;
}

/** A finding inside a report, emitted as a child event linked by parentId (§15.6 / v2.6).
 *  Its absolute-row span backs cross-highlight (§16.8). */
export interface DetectedChild {
  type: MonitorEventType;
  source: MonitorEventSource;
  text: string;
  startRow: number;
  endRow: number;
}

export interface DetectedRegion {
  type: MonitorEventType;
  source: MonitorEventSource;
  text: string;
  startRow: number;
  endRow: number;
  /** Emitted with parentId set to this region's id (§15.6). */
  children?: DetectedChild[];
}

export interface Adapter {
  id: string;
  /** Every classifier runs, then the baseline runs, every scan — no fingerprint/selection (§15.3). */
  detect(ctx: AdapterContext): DetectedRegion[];
  /** True when `text` is one of this agent's end-of-turn meta-summaries — a turn recap printed
   *  below the real output, not the latest report — so on-demand capture skips it as a selection
   *  candidate (§21.1). Absent ⇒ this agent emits no such lines. */
  isMetaSummary?(text: string): boolean;
}
