// §27.10 — a report each step writes its own part of: the section file a step writes and the document the
// engine assembles from those files derive from the one resolver below, so the writer's prompt and the
// assembler cannot disagree on where a section lives.

import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { isSafePathSegment } from '../shared/pathSegment';
import { sliceArtifact } from './appWorkTurn';
import { readDirEntries } from './dirEntries';
import { atomicWriteFileSync } from './atomicFile';
import { confinedRealPathResult } from './confinedPath';
import { isErrno } from './errno';

export interface SectionsDir {
  path: string;
  rel: string;
}

export interface SectionedReport {
  path: string;
  sectionsDir: SectionsDir;
}

export interface ReportSection {
  step: string;
  slice: number;
  body: string;
}

const SECTION_EXT = '.md';
const SECTION_NAME = /^(.+?)(?:\.slice-([1-9][0-9]*))?\.md$/;
const EARLIER_FILE = '_earlier.md';
export const ASSEMBLED_MARKER = '<!-- agent-terminal:assembled-report -->';

export function sectionFile(dir: SectionsDir, step: string, slice: number): { path: string; rel: string } | null {
  if (!isSafePathSegment(step)) return null;
  return sliceArtifact({ path: path.join(dir.path, `${step}${SECTION_EXT}`), rel: `${dir.rel}/${step}${SECTION_EXT}` }, slice);
}

export function sectionOf(fileName: string): { step: string; slice: number } | null {
  const m = SECTION_NAME.exec(fileName);
  if (m === null || !isSafePathSegment(m[1])) return null;
  if (m[2] === undefined) return { step: m[1], slice: 1 };
  const slice = Number(m[2]);
  return slice > 1 ? { step: m[1], slice } : null;
}

export function isAssembledReport(text: string): boolean {
  return text.startsWith(ASSEMBLED_MARKER);
}

export function assembleReport(sections: ReportSection[], stepOrder: readonly string[], earlier: string | null): string {
  const rank = (step: string): number => {
    const i = stepOrder.indexOf(step);
    return i === -1 ? stepOrder.length : i;
  };
  const sorted = [...sections].sort((a, b) => a.slice - b.slice || rank(a.step) - rank(b.step) || a.step.localeCompare(b.step));
  const parts = [...(earlier !== null ? [earlier] : []), ...sorted.map((s) => s.body)].map((p) => p.trimEnd());
  return `${ASSEMBLED_MARKER}\n\n${parts.join('\n\n')}\n`;
}

function readIfPresent(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch (e) {
    if (isErrno(e, 'ENOENT')) return null;
    throw e;
  }
}

function realFolderIfPresent(dir: string): string | null {
  try {
    return realpathSync(dir);
  } catch (e) {
    if (isErrno(e, 'ENOENT')) return null;
    throw e;
  }
}

function writeWhole(file: string, text: string): void {
  if (!atomicWriteFileSync(file, text, { mode: 0o644 })) throw new Error(`${path.basename(file)} could not be written: its folder is not a real directory`);
}

export function assembleReportOnDisk(report: SectionedReport, stepOrder: readonly string[]): 'assembled' | 'nothing-to-assemble' {
  const dir = report.sectionsDir.path;
  const sections: ReportSection[] = [];
  let earlier: string | null = null;
  for (const entry of readDirEntries(dir)) {
    const key = sectionOf(entry.name);
    if (key === null && entry.name !== EARLIER_FILE) continue;
    const file = confinedRealPathResult(dir, path.join(dir, entry.name));
    const rel = `${report.sectionsDir.rel}/${entry.name}`;
    if (!file.ok && file.cause === 'escapes') throw new Error(`the report section ${rel} leads outside ${report.sectionsDir.rel}`);
    if (!file.ok) throw new Error(`the report section ${rel} could not be resolved: it is a broken link or cannot be reached`);
    const body = readFileSync(file.path, 'utf8');
    if (key === null) earlier = body;
    else sections.push({ ...key, body });
  }
  if (sections.length === 0) return 'nothing-to-assemble';
  const reportName = path.basename(report.path);
  const folder = realFolderIfPresent(path.dirname(report.path));
  const leaf = folder === null ? ({ ok: false, cause: 'unresolvable' } as const) : confinedRealPathResult(folder, report.path);
  if (!leaf.ok && leaf.cause === 'escapes') throw new Error(`the report ${reportName} leads outside its folder`);
  if (earlier === null && leaf.ok) {
    const existing = readIfPresent(leaf.path);
    if (existing !== null && !isAssembledReport(existing)) {
      writeWhole(path.join(dir, EARLIER_FILE), existing);
      earlier = existing;
    }
  }
  writeWhole(report.path, assembleReport(sections, stepOrder, earlier));
  return 'assembled';
}
