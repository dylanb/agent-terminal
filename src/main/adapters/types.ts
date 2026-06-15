// Adapter contract (§15.3). Two roles. The glyph-agnostic **baseline** captures
// substantial new non-chrome prose as reports — it always runs and is never gated on
// any agent glyph. A **classifier** (per-agent, e.g. Claude) is enrichment only: it
// recognizes structured blocks (tool-use, diff) and the scanner carves their rows out
// of the baseline. A classifier can never suppress capture — at worst its glyphs don't
// match and the baseline still captures the prose. Adapters assert on observable buffer
// text only, never on internal parser state.

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
  /** True when the absolute row is agent-UI chrome (composer/status/echo/box) — never
   *  content. Structural + profile-driven, so it survives theme customization (§15.x). */
  isChrome(row: number): boolean;
  /** True when the row was claimed by a classifier as a structured block (tool-use /
   *  diff) — the baseline excludes it so the same text isn't also folded into a report. */
  isClaimed?(row: number): boolean;
}

/** A finding inside a report — emitted as a child event linked by parentId (§15.6 / v2.6).
 *  Carries its own on-screen span (absolute rows) so a chunk can cross-highlight (§16.8). */
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
  /** Sub-events (report findings) emitted with parentId set to this region's id. */
  children?: DetectedChild[];
}

export interface Adapter {
  id: string;
  /** Detect regions in the window: a classifier returns structured blocks (tool-use /
   *  diff); the baseline returns prose reports. No fingerprint/selection — every
   *  classifier runs, then the baseline runs, every scan (§15.3). */
  detect(ctx: AdapterContext): DetectedRegion[];
}
