import type { RepeatListFormat } from './engineCapabilities/flow';
import { checkJsonList } from './jsonList';
import { parseSlicePlan, slicePlanWellFormed } from './slicePlan';

/** The entry a repeated work turn is on: its position counted from 1, the standing count, and its shown title. */
export interface RepeatEntry {
  position: number;
  count: number;
  title: string;
}

/** Which list a repeat's count is read from: a `json-list` names its key, every other format has one list. */
export type RepeatListSpec = { format: 'json-list'; list: string } | { format: Exclude<RepeatListFormat, 'json-list'> };

/** The entry titles of the list `spec` names in `text`, in order, or null when the text sources nothing. */
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

/** The count a list of `entries` entries sources while the run is on iteration `currentSlice`, or null to leave
 *  the standing count as it is: a list that cannot carry the run to the iteration it is on never cuts it short. */
export function countToSource(entries: number, currentSlice: number): number | null {
  return entries >= currentSlice ? entries : null;
}
