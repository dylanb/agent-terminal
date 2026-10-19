// §27.10 — a report each step writes its own part of: the section file a step writes and the document the
// engine assembles from those files derive from the one resolver below, so the writer's prompt and the
// assembler cannot disagree on where a section lives.

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { isSafePathSegment } from '../shared/pathSegment';
import { sliceArtifact } from './appWorkTurn';
import { readDirEntries } from './dirEntries';
import { confinedRealPath } from './confinedPath';
import { isErrno } from './errno';

export interface SectionsDir {
  path: string;
  rel: string;
}

export interface SectionedReport {
  path: string;
  sections: SectionsDir;
}

export interface ReportSection {
  step: string;
  slice: number;
  body: string;
}

const SECTION_EXT = '.md';
const SECTION_NAME = /^([a-z0-9][a-z0-9-]*)(?:\.slice-([1-9][0-9]*))?\.md$/;
const EARLIER_FILE = '_earlier.md';
const ASSEMBLED_MARKER = '<!-- agent-terminal:assembled-report -->';

export function sectionFile(dir: SectionsDir, step: string, slice: number): { path: string; rel: string } | null {
  if (!isSafePathSegment(step)) return null;
  return sliceArtifact({ path: path.join(dir.path, `${step}${SECTION_EXT}`), rel: `${dir.rel}/${step}${SECTION_EXT}` }, slice);
}

export function sectionOf(fileName: string): { step: string; slice: number } | null {
  const m = SECTION_NAME.exec(fileName);
  if (m === null) return null;
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

export function assembleReportOnDisk(report: SectionedReport, stepOrder: readonly string[]): 'assembled' | 'nothing-to-assemble' {
  const dir = report.sections.path;
  const sections: ReportSection[] = [];
  let earlier: string | null = null;
  for (const entry of readDirEntries(dir)) {
    const key = sectionOf(entry.name);
    if (key === null && entry.name !== EARLIER_FILE) continue;
    const file = confinedRealPath(dir, path.join(dir, entry.name));
    if (file === null) throw new Error(`the report section ${report.sections.rel}/${entry.name} leads outside ${report.sections.rel}`);
    const body = readFileSync(file, 'utf8');
    if (key === null) earlier = body;
    else sections.push({ ...key, body });
  }
  if (sections.length === 0) return 'nothing-to-assemble';
  if (earlier === null) {
    const existing = readIfPresent(report.path);
    if (existing !== null && !isAssembledReport(existing)) {
      writeFileSync(path.join(dir, EARLIER_FILE), existing);
      earlier = existing;
    }
  }
  writeFileSync(report.path, assembleReport(sections, stepOrder, earlier));
  return 'assembled';
}
