// §28.5.3

import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { loadLoopCapabilities } from './loopCapabilities';
import { confinedRealPathResult, resolveJail } from './confinedPath';
import { APP_LOOP_DIR_SEGMENTS, ARTIFACTS_SUBDIR } from './appLoopPaths';
import { errMsg } from './errno';
import { MAX_RED_CHECK_REPORT_BYTES, parseRedCheckReport, redCheckReportRel, redCheckVerdict, verificationCheckVerdict, type RedCheckClaim } from '../shared/redCheck';
import { readPhaseResult } from '../shared/phaseResult';

export type RedCheckOutcome = { kind: 'unconfigured' } | { kind: 'verified'; claim: RedCheckClaim; unchecked: string[] } | { kind: 'refused'; reason: string };

const refused = (reason: string): RedCheckOutcome => ({ kind: 'refused', reason });

export function redCheckCommand(repoDir: string): string | null {
  const caps = loadLoopCapabilities(repoDir);
  return caps.ok ? (caps.value.redCheckCommand ?? null) : null;
}

export function checkRed(q: { repoDir: string; resultPath: string; addedTestPaths: string[] }): RedCheckOutcome {
  const caps = loadLoopCapabilities(q.repoDir);
  if (!caps.ok) {
    return refused(caps.cause === 'absent' ? 'the RED check cannot run — the repository has no loop-capabilities file' : 'the RED check cannot run — the repository loop-capabilities file is malformed or refused');
  }
  if (caps.value.redCheckCommand === undefined) return { kind: 'unconfigured' };

  const artifacts = resolveJail(q.repoDir, ...APP_LOOP_DIR_SEGMENTS, ARTIFACTS_SUBDIR);
  const repoJail = resolveJail(q.repoDir);
  if (artifacts === null || repoJail === null) return refused('the RED check cannot run — the loop artifacts area is unresolvable');
  const reportName = redCheckReportRel(path.basename(q.resultPath));
  const reportRel = [...APP_LOOP_DIR_SEGMENTS, ARTIFACTS_SUBDIR, reportName].join('/');
  const report = confinedRealPathResult(artifacts, path.join(path.dirname(q.resultPath), reportName));
  if (!report.ok) {
    return refused(report.cause === 'unresolvable' ? `the RED check report ${reportRel} is missing — run the red_check_command` : `the RED check report ${reportRel} is refused — it leads outside the loop artifacts area`);
  }

  try {
    const reportStat = statSync(report.path);
    if (reportStat.size > MAX_RED_CHECK_REPORT_BYTES) return refused(`the RED check report ${reportRel} is too large`);
    for (const rel of q.addedTestPaths) {
      const test = confinedRealPathResult(repoJail, path.join(repoJail, rel));
      if (!test.ok) continue;
      if (statSync(test.path).mtimeMs > reportStat.mtimeMs) {
        return refused(`the RED check report ${reportRel} is older than ${rel} — re-run the red_check_command`);
      }
    }
    const parsed = parseRedCheckReport(readFileSync(report.path, 'utf8'));
    if (!parsed.ok) return refused(`the RED check report ${reportRel} is malformed: ${parsed.reason}`);
    const result = readPhaseResult(readFileSync(q.resultPath, 'utf8'));
    if (!result.ok) return refused(`the RED result ${path.basename(q.resultPath)}: ${result.problem}`);
    const verdict = result.result.verificationOnly
      ? verificationCheckVerdict({ report: parsed.report, addedTestPaths: q.addedTestPaths })
      : redCheckVerdict({ report: parsed.report, intended: result.result.intendedFailures ?? [], addedTestPaths: q.addedTestPaths });
    return verdict.ok ? { kind: 'verified', claim: verdict.claim, unchecked: verdict.unchecked } : refused(verdict.reason);
  } catch (e) {
    return refused(`the RED check could not read its inputs: ${errMsg(e)}`);
  }
}
