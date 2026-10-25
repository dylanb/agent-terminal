import type { PullRequestBodies } from './pullRequestBody';

function composeFlowAudit(body: string, report: string): string {
  const start = '<!-- agent-terminal:flow-audit:start -->';
  const end = '<!-- agent-terminal:flow-audit:end -->';
  if (report.includes(start) || report.includes(end)) {
    throw new Error('audit artifact contains reserved section delimiters');
  }
  const starts = body.split(start);
  const ends = body.split(end);
  const section = `${start}\n${report}${end}\n`;
  if (starts.length === 1 && ends.length === 1) return `${body}\n${section}`;
  const first = body.indexOf(start);
  const last = body.indexOf(end);
  if (starts.length !== 2 || ends.length !== 2 || last < first) {
    throw new Error('PR audit section ownership is ambiguous or malformed');
  }
  const before = body.slice(0, first);
  const after = body.slice(last + end.length);
  if (after === '' || after === '\n') return `${before}${section}`;
  return `${before}${after}\n${section}`;
}

export async function publishFlowAudit(github: PullRequestBodies, pr: number, report: string): Promise<void> {
  if (!report.trim()) throw new Error('refused to publish an empty audit artifact');
  const body = composeFlowAudit(await github.readBody(pr), report);
  await github.replaceBody(pr, body);
  if (await github.readBody(pr) !== body) {
    throw new Error('published PR body does not match the audit and retained description');
  }
}
