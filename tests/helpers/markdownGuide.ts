// Reads the generated engine guide by its Markdown structure — headings, their GitHub anchors, the table
// of contents and the body under each heading — so guide tests locate an entry structurally, never by prose.

export interface GuideHeading {
  level: number;
  /** The heading as written, inline Markdown included. */
  text: string;
  /** The fragment GitHub-flavoured Markdown gives the heading, de-duplicated as GitHub does (`-1`, `-2`). */
  anchor: string;
  /** Zero-based line index. */
  line: number;
}

export interface TocLink {
  text: string;
  anchor: string;
}

const FENCE = /^\s{0,3}(```|~~~)/;
const ATX = /^\s{0,3}(#{1,6})\s+(.*?)(?:\s+#+\s*)?$/;
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+/;
const IN_PAGE_LINK = /\[([^\]]*)\]\(#([^)\s]*)\)/g;

/** Each line outside fenced code blocks, with its index. */
function proseLines(md: string): { text: string; line: number }[] {
  const out: { text: string; line: number }[] = [];
  let fenced = false;
  md.split('\n').forEach((text, line) => {
    if (FENCE.test(text)) fenced = !fenced;
    else if (!fenced) out.push({ text, line });
  });
  return out;
}

function plainText(inline: string): string {
  return inline
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/[*~]/g, '');
}

export function githubSlug(inline: string): string {
  return plainText(inline)
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

export function guideHeadings(md: string): GuideHeading[] {
  const seen = new Map<string, number>();
  return proseLines(md).flatMap(({ text, line }) => {
    const m = ATX.exec(text);
    if (m === null) return [];
    const slug = githubSlug(m[2]);
    const n = seen.get(slug) ?? 0;
    seen.set(slug, n + 1);
    return [{ level: m[1].length, text: m[2], anchor: n === 0 ? slug : `${slug}-${n}`, line }];
  });
}

/** The in-page links of the document's first list, which is where the guide's table of contents sits. */
export function guideTocLinks(md: string): TocLink[] {
  const links: TocLink[] = [];
  let started = false;
  for (const { text } of proseLines(md)) {
    const item = LIST_ITEM.test(text);
    if (!started && !item) continue;
    if (started && !item && text.trim() !== '') break;
    started = true;
    for (const m of text.matchAll(IN_PAGE_LINK)) links.push({ text: m[1], anchor: m[2] });
  }
  return links;
}

/** The lines under `heading` up to the next heading of the same or a higher level, sub-sections included. */
export function sectionBody(md: string, heading: GuideHeading): string {
  const lines = md.split('\n');
  const next = guideHeadings(md).find((h) => h.line > heading.line && h.level <= heading.level);
  return lines.slice(heading.line + 1, next === undefined ? lines.length : next.line).join('\n');
}

/** The headings nested directly or indirectly under `heading`. */
export function subHeadings(md: string, heading: GuideHeading): GuideHeading[] {
  const all = guideHeadings(md);
  const end = all.find((h) => h.line > heading.line && h.level <= heading.level)?.line ?? Number.POSITIVE_INFINITY;
  return all.filter((h) => h.line > heading.line && h.line < end);
}

/** The contents of each inline code span in `inline`, in order. */
export function codeSpans(inline: string): string[] {
  return [...inline.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
}

export interface ListEntry {
  /** The code span the item opens with. */
  code: string;
  /** The item's text, its more-indented continuation lines included. */
  text: string;
}

const LEADING_CODE_ITEM = /^(\s*)(?:[-*+]|\d+[.)])\s+`([^`]+)`/;

/** The list items in `body` that open with a code span — how the guide writes one entry per value or name. */
export function listEntries(body: string): ListEntry[] {
  const lines = body.split('\n');
  const out: ListEntry[] = [];
  lines.forEach((line, i) => {
    const m = LEADING_CODE_ITEM.exec(line);
    if (m === null) return;
    const indent = m[1].length;
    const item = [line];
    for (const next of lines.slice(i + 1)) {
      const nextIndent = next.length - next.trimStart().length;
      if (next.trim() === '' || nextIndent <= indent) break;
      item.push(next);
    }
    out.push({ code: m[2], text: item.join('\n') });
  });
  return out;
}
