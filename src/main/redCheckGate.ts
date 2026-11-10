// §28.5.3

import { statSync } from 'node:fs';
import path from 'node:path';
import { loadLoopCapabilities } from './loopCapabilities';
import { confinedRealPathResult, resolveJail } from './confinedPath';
import { APP_LOOP_DIR_SEGMENTS, ARTIFACTS_SUBDIR, MAX_LOOP_ARTIFACT_BYTES } from './appLoopPaths';
import { readBoundedNoFollow, type BoundedRead } from './boundedRead';
import { errMsg } from './errno';
import { MAX_RED_CHECK_REPORT_BYTES, parseRedCheckReport, redCheckReportRel, redCheckVerdict, verificationCheckVerdict, type RedCheckClaim } from '../shared/redCheck';
import { readPhaseResult } from '../shared/phaseResult';

export type RedCheckOutcome = { kind: 'unconfigured' } | { kind: 'verified'; claim: RedCheckClaim; unchecked: string[] } | { kind: 'refused'; reason: string };

const refused = (reason: string): RedCheckOutcome => ({ kind: 'refused', reason });

const unreadable = (read: Extract<BoundedRead, { ok: false }>): RedCheckOutcome =>
  refused(`the RED check could not read its inputs: ${read.error === undefined ? 'not a regular file' : errMsg(read.error)}`);

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

  const reportRead = readBoundedNoFollow(report.path, MAX_RED_CHECK_REPORT_BYTES);
  if (!reportRead.ok) {
    switch (reportRead.cause) {
      case 'absent':
        return refused(`the RED check report ${reportRel} is missing — run the red_check_command`);
      case 'over-cap':
        return refused(`the RED check report ${reportRel} is too large`);
      case 'unreadable':
        return unreadable(reportRead);
      default:
        return reportRead.cause satisfies never;
    }
  }

  try {
    const reportMtime = statSync(report.path).mtimeMs;
    for (const rel of q.addedTestPaths) {
      const test = confinedRealPathResult(repoJail, path.join(repoJail, rel));
      if (!test.ok) continue;
      if (statSync(test.path).mtimeMs > reportMtime) {
        return refused(`the RED check report ${reportRel} is older than ${rel} — re-run the red_check_command`);
      }
    }
    const parsed = parseRedCheckReport(reportRead.text);
    if (!parsed.ok) return refused(`the RED check report ${reportRel} is malformed: ${parsed.reason}`);
    const resultName = path.basename(q.resultPath);
    const resultRead = readBoundedNoFollow(q.resultPath, MAX_LOOP_ARTIFACT_BYTES);
    if (!resultRead.ok) {
      switch (resultRead.cause) {
        case 'absent':
          return refused(`the RED check could not read its inputs: ${resultName} does not exist`);
        case 'over-cap':
          return refused(`the RED result ${resultName} is too large`);
        case 'unreadable':
          return unreadable(resultRead);
        default:
          return resultRead.cause satisfies never;
      }
    }
    const result = readPhaseResult(resultRead.text);
    if (!result.ok) return refused(`the RED result ${resultName}: ${result.problem}`);
    const verdict = result.result.verificationOnly
      ? verificationCheckVerdict({ report: parsed.report, addedTestPaths: q.addedTestPaths })
      : redCheckVerdict({ report: parsed.report, intended: result.result.intendedFailures ?? [], addedTestPaths: q.addedTestPaths });
    return verdict.ok ? { kind: 'verified', claim: verdict.claim, unchecked: verdict.unchecked } : refused(verdict.reason);
  } catch (e) {
    return refused(`the RED check could not read its inputs: ${errMsg(e)}`);
  }
}
