// §24.2.3 T4 — the ad-hoc re-sign that lets macOS deliver Notification.show() is darwin-only. The gate
// lives here, in node (always present during postinstall), rather than in the bash script it launches, so
// a non-darwin `pnpm install` never has to invoke bash at all — some install environments lack it.
import { execFileSync } from 'node:child_process';

if (process.platform === 'darwin') {
  try {
    execFileSync('bash', ['scripts/sign-bundle.sh'], { stdio: 'inherit' });
  } catch (e) {
    // Best-effort: ad-hoc signing only affects local macOS notification delivery (§24.2.3 T4). A failure
    // here (bash missing from PATH, codesign error, …) must never abort `pnpm install` (CLAUDE.md — a
    // cosmetic side effect must not be able to fail the critical path it sits on).
    console.warn(`postinstall-sign: skipped ad-hoc signing (${e instanceof Error ? e.message : String(e)})`);
  }
}
