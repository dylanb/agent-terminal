import type { RepeatListFormat } from './engineCapabilities/flow';

/** Which list a repeat's count is read from: a `json-list` names its key, every other format has one list. */
export type RepeatListSpec = { format: 'json-list'; list: string } | { format: Exclude<RepeatListFormat, 'json-list'> };

/** The entry titles of the list `spec` names in `text`, in order, or null when the text sources nothing. */
export function repeatListTitles(_spec: RepeatListSpec, _text: string): readonly string[] | null {
  return null;
}

/** The count a list of `entries` entries sources while the run is on iteration `currentSlice`, or null to leave
 *  the standing count as it is. */
export function countToSource(_entries: number, _currentSlice: number): number | null {
  return null;
}
