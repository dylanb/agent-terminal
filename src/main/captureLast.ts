// Manual single-slot capture (§21.1): the pane holds ONE report — each capture replaces the prior.

import type { MonitorEvent, SessionId } from '../shared/ipc';
import type { MonitorEventStore } from './eventStore';
import type { Scanner } from './scanner';

/**
 * Replaces the single report slot (§21.1), returning [report, ...findings] for the pane to render.
 * Manual captures and command-output are left intact. Returns [] (prior capture preserved) when
 * nothing is detected — a scrolled-away buffer must not wipe it.
 */
export function captureLastReport(
  sessionId: SessionId,
  store: MonitorEventStore,
  scanner: Pick<Scanner, 'captureLast'>,
): MonitorEvent[] {
  const result = scanner.captureLast();
  if (!result) return [];

  for (const e of [...store.list()]) {
    if (e.type === 'report') store.remove(e.id); // cascades to its findings (§15.6)
  }

  const report = store.addEvent({
    sessionId,
    type: result.report.type,
    source: result.report.source,
    text: result.report.text,
    range: result.report.range,
    parentId: null,
    truncated: result.report.truncated,
  });
  const findings = result.findings.map((f) =>
    store.addEvent({
      sessionId,
      type: f.type,
      source: f.source,
      text: f.text,
      range: f.range,
      parentId: report.id,
      truncated: f.truncated,
    }),
  );
  return [report, ...findings];
}
