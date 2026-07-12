import { describe, expect, it } from 'vitest';
import { GATE_DECISION_OPTIONS, SESSION_ID } from '../../src/shared/ipc';
import { TITLE_MAX } from '../../src/shared/statusBar';
import {
  isValidCapture,
  isValidCaptureLast,
  isValidCliInstall,
  isValidDismiss,
  isValidDismissAll,
  isValidFlowRequest,
  isValidFlowProvideInput,
  isValidFlowSetTitle,
  isValidFlowGithubRef,
  isValidFlowGateDecision,
  isValidOpenExternal,
  openExternalTarget,
  isValidTemplateList,
  isValidTemplateInstantiate,
  isValidInject,
  isValidInput,
  isValidLearnChrome,
  isValidResize,
  isValidSetSettings,
  isValidTodoAdd,
  isValidTodoDelete,
  isValidTodoList,
  isValidTodoReorder,
  isValidTodoSetStatus,
  isValidTodoUpdate,
  isValidViewerTree,
  isValidViewerRead,
} from '../../src/main/ipcValidation';

const sid = SESSION_ID;

describe('IPC payload validation (§6 — renderer-supplied input is untrusted)', () => {
  it('accepts a well-formed resize and rejects non-positive / non-integer / NaN sizes', () => {
    expect(isValidResize({ sessionId: sid, cols: 80, rows: 24 })).toBe(true);
    expect(isValidResize({ sessionId: sid, cols: 0, rows: 24 })).toBe(false);
    expect(isValidResize({ sessionId: sid, cols: -5, rows: 24 })).toBe(false);
    expect(isValidResize({ sessionId: sid, cols: 80.5, rows: 24 })).toBe(false);
    expect(isValidResize({ sessionId: sid, cols: Number.NaN, rows: 24 })).toBe(false);
    expect(isValidResize({ sessionId: sid, cols: 80 })).toBe(false);
  });

  it('accepts a well-formed learn-chrome and rejects missing/mistyped eventId or sample', () => {
    expect(isValidLearnChrome({ sessionId: sid, eventId: 'e1', sample: '❯ chrome' })).toBe(true);
    expect(isValidLearnChrome({ sessionId: sid, eventId: 'e1' })).toBe(false);
    expect(isValidLearnChrome({ sessionId: sid, sample: '❯ chrome' })).toBe(false);
    expect(isValidLearnChrome({ sessionId: sid, eventId: 7, sample: 'x' })).toBe(false);
    expect(isValidLearnChrome({ sessionId: 'other', eventId: 'e1', sample: 'x' })).toBe(false);
  });

  it('rejects payloads whose sessionId does not match the live session', () => {
    expect(isValidResize({ sessionId: 'other', cols: 80, rows: 24 })).toBe(false);
    expect(isValidInput({ sessionId: 'other', data: 'x' })).toBe(false);
  });

  it('accepts a string-data input and rejects non-string data', () => {
    expect(isValidInput({ sessionId: sid, data: 'ls\n' })).toBe(true);
    expect(isValidInput({ sessionId: sid, data: 123 })).toBe(false);
    expect(isValidInput(null)).toBe(false);
  });

  it('accepts a well-formed inject and rejects non-string text / non-boolean submit', () => {
    expect(isValidInject({ sessionId: sid, text: 'hi', submit: true })).toBe(true);
    expect(isValidInject({ sessionId: sid, text: 5, submit: true })).toBe(false);
    expect(isValidInject({ sessionId: sid, text: 'hi', submit: 'yes' })).toBe(false);
  });

  it('accepts a selection capture and rejects a wrong source or non-string text', () => {
    expect(isValidCapture({ sessionId: sid, text: 'x', range: null, source: 'selection' })).toBe(true);
    expect(isValidCapture({ sessionId: sid, text: 'x', range: null, source: 'other' })).toBe(false);
    expect(isValidCapture({ sessionId: sid, text: 7, range: null, source: 'selection' })).toBe(false);
  });

  it('accepts a well-formed capture:last request and rejects a wrong/missing sessionId (§21.1)', () => {
    expect(isValidCaptureLast({ sessionId: sid })).toBe(true);
    expect(isValidCaptureLast({ sessionId: 'other' })).toBe(false);
    expect(isValidCaptureLast(null)).toBe(false);
  });

  it('accepts a dismiss request and rejects missing/non-string eventId or wrong session (§15.6)', () => {
    expect(isValidDismiss({ sessionId: sid, eventId: 'abc' })).toBe(true);
    expect(isValidDismiss({ sessionId: sid, eventId: 7 })).toBe(false);
    expect(isValidDismiss({ sessionId: sid })).toBe(false);
    expect(isValidDismiss({ sessionId: 'other', eventId: 'abc' })).toBe(false);
  });

  it('accepts a dismiss-all request and rejects a wrong sessionId (§15.6)', () => {
    expect(isValidDismissAll({ sessionId: sid })).toBe(true);
    expect(isValidDismissAll({ sessionId: 'other' })).toBe(false);
    expect(isValidDismissAll(null)).toBe(false);
  });

  // ui:setSettings is global (no sessionId — §16.6); validate the settings shape only.
  it('accepts partial ui settings and rejects wrong-typed fields or a non-object payload', () => {
    expect(isValidSetSettings({ settings: { splitRatio: 0.5 } })).toBe(true);
    expect(isValidSetSettings({ settings: { lastTab: 'todo' } })).toBe(true);
    expect(isValidSetSettings({ settings: { splitRatio: 0.5, lastTab: 'capture' } })).toBe(true);
    expect(isValidSetSettings({ settings: {} })).toBe(true);
    expect(isValidSetSettings({ settings: { theme: 'dark' } })).toBe(true);
    expect(isValidSetSettings({ settings: { theme: 'light' } })).toBe(true);
    expect(isValidSetSettings({ settings: { lastTab: 'bogus' } })).toBe(false);
    expect(isValidSetSettings({ settings: { theme: 'sepia' } })).toBe(false);
    expect(isValidSetSettings({ settings: { splitRatio: 'wide' } })).toBe(false);
    expect(isValidSetSettings({ settings: { splitRatio: Number.NaN } })).toBe(false);
    // Artifact viewer widths (§20.2) cross the renderer→main trust boundary too (§6).
    expect(isValidSetSettings({ settings: { artifactTreeWidth: 248 } })).toBe(true);
    expect(isValidSetSettings({ settings: { artifactFullscreenTreeWidth: 600 } })).toBe(true);
    expect(isValidSetSettings({ settings: { artifactTreeWidth: Number.NaN } })).toBe(false);
    expect(isValidSetSettings({ settings: { artifactTreeWidth: Number.POSITIVE_INFINITY } })).toBe(false);
    expect(isValidSetSettings({ settings: { artifactTreeWidth: '248' } })).toBe(false);
    expect(isValidSetSettings({ settings: { artifactFullscreenTreeWidth: Number.NaN } })).toBe(false);
    expect(isValidSetSettings({ settings: null })).toBe(false);
    expect(isValidSetSettings({})).toBe(false);
    expect(isValidSetSettings(null)).toBe(false);
  });

  it('accepts a flow request with a safe repoKey and rejects a wrong session / unsafe key (§24.2.2)', () => {
    expect(isValidFlowRequest({ sessionId: sid, repoKey: '/repo' })).toBe(true);
    expect(isValidFlowRequest({ sessionId: sid })).toBe(false); // repoKey now required (follows cwd)
    expect(isValidFlowRequest({ sessionId: 'other', repoKey: '/repo' })).toBe(false);
    // repoKey becomes a filesystem path in flowState — same safe-path guard as todos.
    expect(isValidFlowRequest({ sessionId: sid, repoKey: 'relative/path' })).toBe(false);
    expect(isValidFlowRequest({ sessionId: sid, repoKey: '/repo/../../etc' })).toBe(false);
    expect(isValidFlowRequest({})).toBe(false);
    expect(isValidFlowRequest(null)).toBe(false);
    // An array carrying the required props must not pass the trust boundary (arrays are not records).
    const arr: any = [];
    arr.sessionId = sid;
    arr.repoKey = '/repo';
    expect(isValidFlowRequest(arr)).toBe(false);
  });

  it('accepts a flow:setTitle carrying a string title, rejecting bad shapes (§22.3.1)', () => {
    expect(isValidFlowSetTitle({ sessionId: sid, repoKey: '/repo', title: 'Refactor the shadow parser' })).toBe(true);
    expect(isValidFlowSetTitle({ sessionId: sid, repoKey: '/repo', title: '' })).toBe(true); // a blank CLEARS the name
    expect(isValidFlowSetTitle({ sessionId: sid, repoKey: '/repo', title: 176 })).toBe(false); // not a string
    // The name lands in a YAML file re-read and re-parsed on every state query, so an unbounded paste
    // would make every later repaint parse it again (CWE-400).
    expect(isValidFlowSetTitle({ sessionId: sid, repoKey: '/repo', title: 'x'.repeat(TITLE_MAX) })).toBe(true);
    expect(isValidFlowSetTitle({ sessionId: sid, repoKey: '/repo', title: 'x'.repeat(TITLE_MAX + 1) })).toBe(false);
    expect(isValidFlowSetTitle({ sessionId: sid, repoKey: '/repo' })).toBe(false); // title required
    expect(isValidFlowSetTitle({ sessionId: sid, repoKey: 'relative', title: 'x' })).toBe(false); // unsafe key
    expect(isValidFlowSetTitle({ sessionId: 'other', repoKey: '/repo', title: 'x' })).toBe(false);
    expect(isValidFlowSetTitle(null)).toBe(false);
    const arr: any = [];
    arr.sessionId = sid;
    arr.repoKey = '/repo';
    arr.title = 'x';
    expect(isValidFlowSetTitle(arr)).toBe(false); // arrays are not records
  });

  it('accepts a flow:provideInput with a string→string values map, rejecting bad shapes (§24.2.3 T3)', () => {
    expect(isValidFlowProvideInput({ sessionId: sid, repoKey: '/repo', values: { ticket: '176' } })).toBe(true);
    expect(isValidFlowProvideInput({ sessionId: sid, repoKey: '/repo', values: {} })).toBe(true); // empty is fine
    expect(isValidFlowProvideInput({ sessionId: sid, repoKey: '/repo', values: { ticket: 176 } })).toBe(false); // non-string value
    expect(isValidFlowProvideInput({ sessionId: sid, repoKey: '/repo' })).toBe(false); // values required
    expect(isValidFlowProvideInput({ sessionId: sid, repoKey: '/repo', values: [] })).toBe(false); // not a record
    expect(isValidFlowProvideInput({ sessionId: sid, repoKey: 'relative', values: {} })).toBe(false); // unsafe key
    expect(isValidFlowProvideInput({ sessionId: 'other', repoKey: '/repo', values: {} })).toBe(false);
    expect(isValidFlowProvideInput(null)).toBe(false);
    // An array carrying the required props must not pass the trust boundary (arrays are not records).
    const arr: any = [];
    arr.sessionId = sid;
    arr.repoKey = '/repo';
    arr.values = {};
    expect(isValidFlowProvideInput(arr)).toBe(false);
  });

  it('accepts a flow:githubRef with a valid kind + positive number, rejecting bad shapes (§24.2.3 T7)', () => {
    expect(isValidFlowGithubRef({ sessionId: sid, repoKey: '/repo', kind: 'issue', number: 25 })).toBe(true);
    expect(isValidFlowGithubRef({ sessionId: sid, repoKey: '/repo', kind: 'pr', number: 29 })).toBe(true);
    expect(isValidFlowGithubRef({ sessionId: sid, repoKey: '/repo', kind: 'commit', number: 1 })).toBe(false); // bad kind
    expect(isValidFlowGithubRef({ sessionId: sid, repoKey: '/repo', kind: 'issue', number: 0 })).toBe(false); // not positive
    expect(isValidFlowGithubRef({ sessionId: sid, repoKey: '/repo', kind: 'issue', number: 1.5 })).toBe(false); // not integer
    expect(isValidFlowGithubRef({ sessionId: sid, repoKey: 'relative', kind: 'issue', number: 1 })).toBe(false); // unsafe key
    expect(isValidFlowGithubRef({ sessionId: 'other', repoKey: '/repo', kind: 'issue', number: 1 })).toBe(false);
    expect(isValidFlowGithubRef(null)).toBe(false);
  });

  it('confines a flow:gateDecision option to the known set + guards repoKey/session/note (§26.6 / L5)', () => {
    expect(isValidFlowGateDecision({ sessionId: sid, repoKey: '/repo', option: 'approve' })).toBe(true);
    expect(isValidFlowGateDecision({ sessionId: sid, repoKey: '/repo', option: 'request-changes' })).toBe(true);
    expect(isValidFlowGateDecision({ sessionId: sid, repoKey: '/repo', option: 'impasse', note: 'why' })).toBe(true);
    expect(isValidFlowGateDecision({ sessionId: sid, repoKey: '/repo', option: 'terminate' })).toBe(false); // not an offered option
    expect(isValidFlowGateDecision({ sessionId: sid, repoKey: '/repo' })).toBe(false); // option required
    expect(isValidFlowGateDecision({ sessionId: sid, repoKey: '/repo', option: 'approve', note: 42 })).toBe(false); // note must be a string
    expect(isValidFlowGateDecision({ sessionId: sid, repoKey: 'relative', option: 'approve' })).toBe(false); // unsafe key
    expect(isValidFlowGateDecision({ sessionId: 'other', repoKey: '/repo', option: 'approve' })).toBe(false); // dead session
    expect(isValidFlowGateDecision([])).toBe(false); // not a record
    expect(isValidFlowGateDecision(null)).toBe(false);
  });

  it('accepts exactly the shared GATE_DECISION_OPTIONS set — one source for the validator (§26.6)', () => {
    for (const option of GATE_DECISION_OPTIONS) {
      expect(isValidFlowGateDecision({ sessionId: sid, repoKey: '/repo', option })).toBe(true);
    }
    expect(isValidFlowGateDecision({ sessionId: sid, repoKey: '/repo', option: 'defer' })).toBe(false);
  });

  it('accepts an app:openExternal with a string url, rejecting bad shapes (host check is the handler\'s job)', () => {
    expect(isValidOpenExternal({ sessionId: sid, url: 'https://github.com/o/r/issues/1' })).toBe(true);
    expect(isValidOpenExternal({ sessionId: sid, url: 42 })).toBe(false); // non-string
    expect(isValidOpenExternal({ sessionId: sid })).toBe(false); // url required
    expect(isValidOpenExternal({ sessionId: 'other', url: 'https://github.com' })).toBe(false);
    expect(isValidOpenExternal(null)).toBe(false);
  });

  // The handler opens exactly openExternalTarget()'s return — the NORMALIZED url, never the raw payload
  // — so a non-GitHub/non-https url is refused (null) and a host-spoofing control char cannot make the
  // OS open a different host than the allow-list approved (CWE-601 validator-sink parser differential).
  it('openExternalTarget resolves a valid GitHub url to its normalized form and refuses everything else', () => {
    expect(openExternalTarget({ sessionId: sid, url: 'https://github.com/o/r/issues/1' })).toBe(
      'https://github.com/o/r/issues/1',
    );
    expect(openExternalTarget({ sessionId: sid, url: 'https://evil.com/x' })).toBeNull(); // non-GitHub
    expect(openExternalTarget({ sessionId: sid, url: 'javascript:alert(1)' })).toBeNull(); // non-https
    expect(openExternalTarget({ sessionId: sid })).toBeNull(); // bad shape
    expect(openExternalTarget({ sessionId: 'other', url: 'https://github.com' })).toBeNull(); // wrong session
    const smuggled = openExternalTarget({ sessionId: sid, url: 'https://evil.com\t.github.com/x' });
    expect(smuggled).toBe('https://evil.com.github.com/x'); // tab stripped: opens the validated host, not the raw string
  });

  it('rejects array-shaped payloads at the trust boundary (arrays are not records)', () => {
    const a: any = [];
    a.sessionId = sid;
    expect(isValidCaptureLast(a)).toBe(false);
  });

  it('accepts a todoTemplate:list with a safe repoKey and rejects an unsafe key / wrong session', () => {
    expect(isValidTemplateList({ sessionId: sid, repoKey: '/repo' })).toBe(true);
    expect(isValidTemplateList({ sessionId: sid, repoKey: 'relative' })).toBe(false);
    expect(isValidTemplateList({ sessionId: sid, repoKey: '/repo/../../etc' })).toBe(false);
    expect(isValidTemplateList({ sessionId: sid })).toBe(false);
    expect(isValidTemplateList({ sessionId: 'other', repoKey: '/repo' })).toBe(false);
    expect(isValidTemplateList(null)).toBe(false);
  });

  it('accepts a todoTemplate:instantiate and rejects traversal/empty/non-string ref (§21.2 boundary guard)', () => {
    expect(isValidTemplateInstantiate({ sessionId: sid, repoKey: '/repo', ref: 'impl-loop-review' })).toBe(true);
    expect(isValidTemplateInstantiate({ sessionId: sid, repoKey: '/repo', ref: '' })).toBe(false); // empty
    expect(isValidTemplateInstantiate({ sessionId: sid, repoKey: '/repo', ref: '../x' })).toBe(false); // traversal
    expect(isValidTemplateInstantiate({ sessionId: sid, repoKey: '/repo', ref: 'a/../b' })).toBe(false); // traversal
    expect(isValidTemplateInstantiate({ sessionId: sid, repoKey: '/repo', ref: 'a\\..\\b' })).toBe(false); // backslash traversal
    expect(isValidTemplateInstantiate({ sessionId: sid, repoKey: '/repo', ref: 7 })).toBe(false); // non-string
    expect(isValidTemplateInstantiate({ sessionId: sid, repoKey: 'relative', ref: 'x' })).toBe(false); // unsafe key
    expect(isValidTemplateInstantiate({ sessionId: 'other', repoKey: '/repo', ref: 'x' })).toBe(false);
    expect(isValidTemplateInstantiate(null)).toBe(false);
  });

  // ---- todo:* validators (§16.3 / §16.4) ----

  it('accepts a todo:list and rejects a missing/non-string repoKey or wrong session', () => {
    expect(isValidTodoList({ sessionId: sid, repoKey: '/repo' })).toBe(true);
    expect(isValidTodoList({ sessionId: sid, repoKey: 7 })).toBe(false);
    expect(isValidTodoList({ sessionId: sid })).toBe(false);
    expect(isValidTodoList({ sessionId: 'other', repoKey: '/repo' })).toBe(false);
    // repoKey becomes a filesystem write path in todoStore — reject non-absolute or
    // traversal-laden keys at the trust boundary (§6) so a buggy/hostile renderer can't
    // write a todos.json outside the repo.
    expect(isValidTodoList({ sessionId: sid, repoKey: 'relative/path' })).toBe(false);
    expect(isValidTodoList({ sessionId: sid, repoKey: '/repo/../../etc' })).toBe(false);
  });

  it('accepts a todo:add with/without a source and rejects bad text or source', () => {
    expect(isValidTodoAdd({ sessionId: sid, repoKey: '/r', text: 'do it' })).toBe(true);
    expect(isValidTodoAdd({ sessionId: sid, repoKey: '/r', text: 'x', source: { type: 'finding', eventId: 'e1' } })).toBe(true);
    expect(isValidTodoAdd({ sessionId: sid, repoKey: '/r', text: 'x', source: { type: 'manual' } })).toBe(true);
    expect(isValidTodoAdd({ sessionId: sid, repoKey: '/r', text: 7 })).toBe(false);
    expect(isValidTodoAdd({ sessionId: sid, repoKey: '/r', text: 'x', source: { type: 'bogus' } })).toBe(false);
    expect(isValidTodoAdd({ sessionId: sid, repoKey: '/r', text: 'x', source: { type: 'finding', eventId: 7 } })).toBe(false);
    expect(isValidTodoAdd({ sessionId: sid, text: 'x' })).toBe(false);
  });

  it('accepts a todo:update and rejects missing id/text', () => {
    expect(isValidTodoUpdate({ sessionId: sid, repoKey: '/r', id: 'a', text: 'b' })).toBe(true);
    expect(isValidTodoUpdate({ sessionId: sid, repoKey: '/r', id: 'a' })).toBe(false);
    expect(isValidTodoUpdate({ sessionId: sid, repoKey: '/r', id: 7, text: 'b' })).toBe(false);
  });

  it('accepts a todo:reorder with a string[] and rejects a non-array / non-string entries', () => {
    expect(isValidTodoReorder({ sessionId: sid, repoKey: '/r', orderedIds: ['a', 'b'] })).toBe(true);
    expect(isValidTodoReorder({ sessionId: sid, repoKey: '/r', orderedIds: [] })).toBe(true);
    expect(isValidTodoReorder({ sessionId: sid, repoKey: '/r', orderedIds: 'a' })).toBe(false);
    expect(isValidTodoReorder({ sessionId: sid, repoKey: '/r', orderedIds: ['a', 7] })).toBe(false);
  });

  it('accepts a todo:setStatus with a valid status and rejects anything else', () => {
    expect(isValidTodoSetStatus({ sessionId: sid, repoKey: '/r', id: 'a', status: 'done' })).toBe(true);
    expect(isValidTodoSetStatus({ sessionId: sid, repoKey: '/r', id: 'a', status: 'active' })).toBe(true);
    expect(isValidTodoSetStatus({ sessionId: sid, repoKey: '/r', id: 'a', status: 'in_progress' })).toBe(true);
    expect(isValidTodoSetStatus({ sessionId: sid, repoKey: '/r', id: 'a', status: 'maybe' })).toBe(false);
    expect(isValidTodoSetStatus({ sessionId: sid, repoKey: '/r', id: 'a' })).toBe(false);
  });

  it('accepts a todo:delete and rejects a missing id', () => {
    expect(isValidTodoDelete({ sessionId: sid, repoKey: '/r', id: 'a' })).toBe(true);
    expect(isValidTodoDelete({ sessionId: sid, repoKey: '/r' })).toBe(false);
  });

  // ---- viewer:* validators (§20.1 / §20.2) ----

  it('accepts a viewer:tree with a known scope and rejects a bad/missing scope or wrong session', () => {
    expect(isValidViewerTree({ sessionId: sid, scope: 'curated' })).toBe(true);
    expect(isValidViewerTree({ sessionId: sid, scope: 'repo' })).toBe(true);
    expect(isValidViewerTree({ sessionId: sid, scope: 'bogus' })).toBe(false);
    expect(isValidViewerTree({ sessionId: sid, scope: 7 })).toBe(false);
    expect(isValidViewerTree({ sessionId: sid })).toBe(false); // scope required
    expect(isValidViewerTree({ sessionId: 'other', scope: 'curated' })).toBe(false);
    expect(isValidViewerTree(null)).toBe(false);
  });

  it('accepts a cli:install for the live session and rejects a wrong/missing session', () => {
    expect(isValidCliInstall({ sessionId: sid })).toBe(true);
    expect(isValidCliInstall({ sessionId: 'other' })).toBe(false);
    expect(isValidCliInstall(null)).toBe(false);
  });

  it('accepts a viewer:read with a string relPath and rejects missing/non-string relPath or wrong session', () => {
    expect(isValidViewerRead({ sessionId: sid, relPath: 'src/a.ts' })).toBe(true);
    expect(isValidViewerRead({ sessionId: sid, relPath: '' })).toBe(true); // emptiness is the loader's concern; the boundary only types it
    expect(isValidViewerRead({ sessionId: sid, relPath: 7 })).toBe(false);
    expect(isValidViewerRead({ sessionId: sid })).toBe(false); // relPath required
    expect(isValidViewerRead({ sessionId: 'other', relPath: 'src/a.ts' })).toBe(false);
    expect(isValidViewerRead(null)).toBe(false);
  });
});
