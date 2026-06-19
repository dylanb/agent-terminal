// Manual single-slot capture (§21.1 / v2.27). "Capture last report" runs report-detection on
// demand and the pane holds ONE report — each capture replaces the prior. This is the store-side
// of that contract, factored out of the IPC handler so it is testable without Electron.

import type { MonitorEvent, SessionId } from '../shared/ipc';
import type { MonitorEventStore } from './eventStore';
import type { Scanner } from './scanner';

/**
 * Detect the latest report now and make it the pane's single captured report (§21.1): replace
 * any prior report (and its findings) in the store with the freshly-detected one, returning the
 * stored events (report first, then findings) for the pane to render. Manual captures and
 * command-output are untouched — only the report slot is single. Returns [] when nothing is
 * detected, leaving any prior capture in place (a scrolled-away buffer must not wipe it).
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
