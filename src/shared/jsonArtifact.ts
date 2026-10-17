// §27.12 — one reading for every agent-written JSON artifact the engine gates on (goal progress, round report,
// consolidator verdict, phase result), so the readers cannot differ on a byte order mark or on what they say
// about text that is not a JSON object.

const BYTE_ORDER_MARK = '﻿';

export function isJsonRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** The problem is fixed text, never the file's own. */
export function readJsonObject(text: string): { ok: true; doc: Record<string, unknown> } | { ok: false; problem: string } {
  let doc: unknown;
  try {
    doc = JSON.parse(text.startsWith(BYTE_ORDER_MARK) ? text.slice(BYTE_ORDER_MARK.length) : text);
  } catch {
    return { ok: false, problem: 'it is not valid JSON' };
  }
  return isJsonRecord(doc) ? { ok: true, doc } : { ok: false, problem: 'it is not a JSON object' };
}
