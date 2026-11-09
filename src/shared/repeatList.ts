import type { RepeatListFormat } from './engineCapabilities/flow';
import { stripDisplayControlChars } from './controlChars';
import { checkJsonList } from './jsonList';
import { parseSlicePlan, slicePlanWellFormed } from './slicePlan';

export interface RepeatEntry {
  position: number;
  count: number;
  title: string;
}

export const REPEAT_ENTRY_TITLE_MAX = 100;

export function repeatEntryTitle(raw: string): string {
  return Array.from(stripDisplayControlChars(raw)).slice(0, REPEAT_ENTRY_TITLE_MAX).join('');
}

export type RepeatListSpec = { format: 'json-list'; list: string } | { format: Exclude<RepeatListFormat, 'json-list'> };

export function repeatListTitles(spec: RepeatListSpec, text: string): readonly string[] | null {
  switch (spec.format) {
    case 'json-list': {
      const checked = checkJsonList(text, spec.list);
      return checked.ok ? checked.titles : null;
    }
    case 'impl-slices':
      return slicePlanWellFormed(text) ? parseSlicePlan(text).implSlices.map((s) => s.title) : null;
    default: {
      const unhandled: never = spec;
      return unhandled;
    }
  }
}

export function countToSource(entries: number, currentSlice: number): number | null {
  return entries >= currentSlice ? entries : null;
}
