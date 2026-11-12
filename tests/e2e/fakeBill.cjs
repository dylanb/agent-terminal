// The e2e fake agent's token biller (tests/e2e/fakeTools.ts): appends the usage records seeded for it, stamped with
// the current time to the millisecond, in the form of the agent it was invoked as. The records' shapes come
// pre-rendered from tests/helpers/agentUsageLogs.ts; this only fills the placeholders and keeps a Codex session's
// cumulative total, which depends on what the session billed before.
// argv: <invoked name> <agent pid> <start|bill> <base64 JSON payload>
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const [name, pid, action, encoded] = process.argv.slice(2);
const payload = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
const { at: AT, cwd: CWD, total: TOTAL, pid: PID, run: RUN } = payload.placeholders;
const now = new Date().toISOString();
const run = require('node:crypto').randomUUID();
const fill = (text) =>
  text.split(AT).join(now).split(RUN).join(run).split(PID).join(pid).split(JSON.stringify(CWD)).join(JSON.stringify(process.cwd()));
const append = (file, lines) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, lines.map((line) => `${line}\n`).join(''));
};
const fail = (message) => {
  process.stderr.write(`fake agent (${name}): ${message}\n`);
  process.exit(2);
};
const sessionState = path.join(payload.stateDir, `codex-session-${pid}.json`);

if (name === 'claude') {
  if (action === 'bill') for (const write of payload.claude) append(write.file, write.lines.map(fill));
} else if (name === 'codex') {
  if (action === 'start') {
    const file = fill(payload.codex.file);
    append(file, [fill(payload.codex.meta)]);
    fs.writeFileSync(sessionState, JSON.stringify({ file, total: {} }));
  } else {
    if (payload.codex.error) fail(payload.codex.error);
    if (!fs.existsSync(sessionState)) fail('no Codex session was started for this agent');
    const session = JSON.parse(fs.readFileSync(sessionState, 'utf8'));
    const lines = payload.codex.records.map(({ last, line }) => {
      for (const [key, n] of Object.entries(last)) session.total[key] = (session.total[key] || 0) + n;
      return fill(line).split(JSON.stringify(TOTAL)).join(JSON.stringify(session.total));
    });
    append(session.file, lines);
    fs.writeFileSync(sessionState, JSON.stringify(session));
  }
} else if (action === 'bill') {
  fail('token usage needs the fake agent invoked as claude or codex');
}
