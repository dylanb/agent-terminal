// Finds a position's, a key's or a side-effect arg's section in the generated engine guide (#276) by the oracle's
// ids, never by prose: a position is the heading carrying its id as a code span; a key, a heading under it
// carrying the key; an arg, a heading under it carrying the side-effect kind and the arg.

import { codeSpans, guideHeadings, subHeadings, type GuideHeading } from './markdownGuide';
import { POSITIONS, type PositionId } from './engineCapabilityOracle';

const POSITION_IDS = new Set<string>(Object.keys(POSITIONS));
const isPositionId = (s: string): s is PositionId => POSITION_IDS.has(s);

function sectionEnd(md: string, heading: GuideHeading): number {
  return guideHeadings(md).find((h) => h.line > heading.line && h.level <= heading.level)?.line ?? Number.POSITIVE_INFINITY;
}

/** Whether `heading` sits in the section of another position that reads a key named `name` — the flow step's
 *  `loop` key, not the loop definition's top level. */
function isKeyOfEnclosingPosition(md: string, heading: GuideHeading, name: string): boolean {
  return guideHeadings(md).some(
    (p) =>
      p.line < heading.line &&
      heading.line < sectionEnd(md, p) &&
      codeSpans(p.text).some((c) => c !== name && isPositionId(c) && name in POSITIONS[c].keys),
  );
}

export function positionHeading(md: string, id: PositionId): GuideHeading | undefined {
  return guideHeadings(md).find((h) => codeSpans(h.text).includes(id) && !isKeyOfEnclosingPosition(md, h, id));
}

/** The heading of the position section that most closely encloses `heading`. */
function owningPosition(md: string, heading: GuideHeading): GuideHeading | undefined {
  return guideHeadings(md)
    .filter(
      (h) =>
        h.line < heading.line &&
        heading.line < sectionEnd(md, h) &&
        codeSpans(h.text).some((c) => isPositionId(c) && positionHeading(md, c)?.line === h.line),
    )
    .at(-1);
}

/** A heading under a position's section whose code spans include every one of `spans`, owned by no position nested
 *  inside it. */
function headingUnder(md: string, id: PositionId, spans: readonly string[]): GuideHeading | undefined {
  const pos = positionHeading(md, id);
  if (pos === undefined) return undefined;
  return subHeadings(md, pos).find((h) => spans.every((s) => codeSpans(h.text).includes(s)) && owningPosition(md, h)?.line === pos.line);
}

export function keyHeading(md: string, id: PositionId, key: string): GuideHeading | undefined {
  return headingUnder(md, id, [key]);
}

/** The heading of an arg the engine reads beside a side-effect `kind`. */
export function argHeading(md: string, id: PositionId, kind: string, arg: string): GuideHeading | undefined {
  return headingUnder(md, id, [kind, arg]);
}

/** The text between a heading and the next heading of any level. */
export function intro(md: string, heading: GuideHeading): string {
  const lines = md.split('\n');
  const next = guideHeadings(md).find((h) => h.line > heading.line)?.line ?? lines.length;
  return lines.slice(heading.line + 1, next).join('\n');
}

export function headingTitled(md: string, title: string): GuideHeading | undefined {
  return title.trim() === '' ? undefined : guideHeadings(md).find((h) => h.text.trim() === title.trim());
}
