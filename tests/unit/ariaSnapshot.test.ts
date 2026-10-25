import { describe, expect, it } from 'vitest';
import { exposedText, nodesWithRole, parseAriaSnapshot, wholeText } from '../helpers/ariaSnapshot';

const SNAPSHOT = [
  '- paragraph: Startup paused',
  '- heading "Waiting for the controller" [level=1]',
  '- list:',
  '  - listitem:',
  '    - text: "macOS: Open X ("',
  '    - code: x.app',
  '    - text: ) from y.',
  '  - listitem: "Linux: Open z."',
  '- status',
  '- status: Not connected yet.',
].join('\n');

describe('parseAriaSnapshot', () => {
  it('reads every exposed string in tree order, unquoting quoted scalars and taking a name as text', () => {
    expect(exposedText(parseAriaSnapshot(SNAPSHOT))).toEqual([
      'Startup paused',
      'Waiting for the controller',
      'macOS: Open X (',
      'x.app',
      ') from y.',
      'Linux: Open z.',
      'Not connected yet.',
    ]);
  });

  it('nests children by indentation, so a node carries the text of its subtree', () => {
    const [list] = nodesWithRole(parseAriaSnapshot(SNAPSHOT), 'list');
    expect(list.children.map(wholeText)).toEqual(['macOS: Open X ( x.app ) from y.', 'Linux: Open z.']);
  });

  it('exposes an empty region with no text', () => {
    expect(nodesWithRole(parseAriaSnapshot(SNAPSHOT), 'status').map(wholeText)).toEqual(['', 'Not connected yet.']);
  });

  it('throws on a line it does not recognise rather than dropping its text', () => {
    expect(() => parseAriaSnapshot('- paragraph: ok\n- /url: https://example.com')).toThrow(/url/);
  });
});
