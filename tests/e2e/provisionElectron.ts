import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

// Electron 42 downloads its binary on first resolution when it is missing. Resolving it here, once, in
// Playwright's global setup keeps parallel workers from each downloading into the same dist/ and
// launching a half-written executable (`spawn ETXTBSY`).
export default function provisionElectron(): void {
  const electronPath = createRequire(__filename)('electron') as string;
  if (!existsSync(electronPath)) throw new Error(`Electron executable missing after resolution: ${electronPath}`);
}
