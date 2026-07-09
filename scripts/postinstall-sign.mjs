// §24.2.3 T4 — the ad-hoc re-sign that lets macOS deliver Notification.show() is darwin-only. The gate
// lives here, in node (always present during postinstall), rather than in the bash script it launches, so
// a non-darwin `pnpm install` never has to invoke bash at all — some install environments lack it.
import { execFileSync } from 'node:child_process';

if (process.platform === 'darwin') {
  execFileSync('bash', ['scripts/sign-bundle.sh'], { stdio: 'inherit' });
}
