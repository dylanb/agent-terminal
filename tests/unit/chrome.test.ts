import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CHROME_MARKERS,
  chromeRows,
  isChromeLine,
  isRuleLine,
  leadingMarker,
  learnMarkers,
} from '../../src/main/chrome';

/** A minimal reader over fixed lines — config injection, not an emulator mock (§15.8). */
function fakeReader(lines: string[], cols = 80, baseY = 0) {
  return { cols: () => cols, baseY: () => baseY, lineText: (y: number) => lines[y] ?? '' };
}

describe('chrome detection helpers (§15.x — customization-proof furniture)', () => {
  describe('isRuleLine — a full-width horizontal rule, any repeated glyph', () => {
    it('accepts a long run of one box-drawing glyph spanning most of the width', () => {
      expect(isRuleLine('─'.repeat(78), 80)).toBe(true);
      expect(isRuleLine('═'.repeat(80), 80)).toBe(true);
      // theme could use a plain dash or em-dash — still a rule
      expect(isRuleLine('-'.repeat(80), 80)).toBe(true);
      expect(isRuleLine('—'.repeat(70), 80)).toBe(true);
    });

    it('tolerates surrounding whitespace (the line is trimmed)', () => {
      expect(isRuleLine('  ' + '─'.repeat(76) + '  ', 80)).toBe(true);
    });

    it('rejects short rules, mixed glyphs, and alphanumeric content', () => {
      expect(isRuleLine('---', 80)).toBe(false); // a markdown hr is too short to be the composer frame
      expect(isRuleLine('─'.repeat(10), 80)).toBe(false); // below the width fraction
      expect(isRuleLine('─'.repeat(40) + 'x' + '─'.repeat(37), 80)).toBe(false); // not a single glyph
      expect(isRuleLine('a'.repeat(80), 80)).toBe(false); // alphanumeric, not a rule glyph
      expect(isRuleLine('', 80)).toBe(false);
    });
  });

  describe('leadingMarker — the line\'s leading symbol token', () => {
    it('returns the leading run of non-space, non-alphanumeric glyphs', () => {
      expect(leadingMarker('❯ tell me about this')).toBe('❯');
      expect(leadingMarker('  ✻ Baked for 10m 58s')).toBe('✻');
      expect(leadingMarker('⏵⏵ auto mode on (shift+tab to cycle)')).toBe('⏵⏵');
      expect(leadingMarker('  ⎿  Compacted (ctrl+o to see full summary)')).toBe('⎿');
    });

    it('returns empty for lines that begin with text or are blank', () => {
      expect(leadingMarker('Overall the change looks solid')).toBe('');
      expect(leadingMarker('   ')).toBe('');
      expect(leadingMarker('123 go')).toBe('');
    });
  });

  describe('learnMarkers — capture the chrome glyphs from a sample', () => {
    it('collects each line\'s unique leading marker, ignoring text/blank lines', () => {
      const sample =
        '✻ Baked for 10m 58s\n' +
        '\n' +
        '❯ /compact keep only the summary\n' +
        '  ⎿  Compacted (ctrl+o to see full summary)\n' +
        'this line is prose and contributes no marker\n';
      expect(learnMarkers(sample).sort()).toEqual(['❯', '✻', '⎿'].sort());
    });

    it('returns nothing for an all-prose sample', () => {
      expect(learnMarkers('just words\nand more words')).toEqual([]);
    });
  });

  describe('isChromeLine — a line whose leading marker is in the profile', () => {
    it('matches a profile marker and ignores unrelated markers', () => {
      expect(isChromeLine('❯ /compact ...', ['❯', '✻'])).toBe(true);
      expect(isChromeLine('✻ Baked for 1s', ['❯', '✻'])).toBe(true);
      expect(isChromeLine('⎿ tool result', ['❯', '✻'])).toBe(false); // ⎿ not in profile (it rides tool blocks)
      expect(isChromeLine('Overall looks good', ['❯', '✻'])).toBe(false);
    });

    it('the seeded defaults flag the stock composer/spinner/mode lines', () => {
      expect(isChromeLine('❯ hello', DEFAULT_CHROME_MARKERS)).toBe(true);
      expect(isChromeLine('✻ Baked for 2m', DEFAULT_CHROME_MARKERS)).toBe(true);
      expect(isChromeLine('⏵⏵ auto mode on', DEFAULT_CHROME_MARKERS)).toBe(true);
      // ⎿ continuations belong to ⏺ tool/diff blocks — never seeded as chrome
      expect(DEFAULT_CHROME_MARKERS).not.toContain('⎿');
    });
  });

  describe('chromeRows — continuation-aware furniture over a window', () => {
    it('a ❯ command echo consumes its indented ⎿ result lines as chrome', () => {
      const lines = ['❯ /compact keep the summary', '  ⎿  Compacted', '  ⎿  Read file', 'Real prose follows here'];
      const isChrome = chromeRows(fakeReader(lines), 0, 3, ['❯']);
      expect(isChrome(0)).toBe(true); // the ❯ echo line
      expect(isChrome(1)).toBe(true); // ⎿ continuation under chrome
      expect(isChrome(2)).toBe(true);
      expect(isChrome(3)).toBe(false); // back to real prose
    });

    it('a ⎿ under a non-chrome ⏺ tool head stays content (not chrome)', () => {
      const lines = ['⏺ Read(src/x.ts)', '  ⎿  Read 93 lines'];
      const isChrome = chromeRows(fakeReader(lines), 0, 1, DEFAULT_CHROME_MARKERS);
      expect(isChrome(0)).toBe(false);
      expect(isChrome(1)).toBe(false);
    });

    it('the bottom rule-framed composer region is chrome by geometry', () => {
      const rule = '─'.repeat(78);
      const lines = ['real report prose above the composer', rule, '❯', rule, '  ⏵⏵ auto mode on'];
      const isChrome = chromeRows(fakeReader(lines), 0, 4, DEFAULT_CHROME_MARKERS);
      expect(isChrome(0)).toBe(false);
      expect(isChrome(1)).toBe(true);
      expect(isChrome(4)).toBe(true);
    });

    it('a full-width-rule-framed permission prompt is chrome top-rule → bottom, tall tail and all', () => {
      const rule = '─'.repeat(78);
      const lines = [
        'real report content above the prompt that must stay capturable as a finding here',
        rule, //                                              1  prompt top rule
        ' ☐ Proceed?', //                                     2
        '', //                                                3
        'Would you like to proceed?', //                      4
        '', //                                                5
        '❯ 1. Yes', //                                        6  selector lives inside the frame
        '     Continue with the action.', //                 7
        '  2. No', //                                         8
        '  3. Type something.', //                            9
        rule, //                                             10  prompt bottom rule
        '  4. Chat about this', //                           11  tail below the bottom rule...
        '  5. Always allow', //                              12
        '', //                                               13
        'Enter to select · up/down to navigate · Esc', //    14
        'Press ? for shortcuts', //                          15
      ];
      const isChrome = chromeRows(fakeReader(lines), 0, 15, DEFAULT_CHROME_MARKERS);
      expect(isChrome(0)).toBe(false); // report content above the frame is NOT chrome
      expect(isChrome(1)).toBe(true); //  top rule
      expect(isChrome(6)).toBe(true); //  prompt body (the ❯ selector)
      expect(isChrome(10)).toBe(true); // bottom rule
      expect(isChrome(15)).toBe(true); // the tall tail is chrome too (no BOTTOM_BAND limit)
    });

    it('a lone full-width rule in report content (composer below) does not make the report chrome', () => {
      const rule = '─'.repeat(78);
      const lines = [
        'report intro paragraph that is long enough to be real content on its own here',
        rule, //                          1  a content separator inside the report
        'report tail paragraph still real content that continues after the separator', // 2
        rule, //                          3  composer top rule
        '❯', //                           4
        rule, //                          5  composer bottom rule
        '  ⏵⏵ auto mode on', //           6
      ];
      const isChrome = chromeRows(fakeReader(lines), 0, 6, DEFAULT_CHROME_MARKERS);
      expect(isChrome(1)).toBe(false); // content separator — only the bottom-most pair frames chrome
      expect(isChrome(2)).toBe(false); // report tail above the composer stays content
      expect(isChrome(3)).toBe(true); //  composer top rule
      expect(isChrome(6)).toBe(true); //  status tail
    });

    it('a box is NOT chrome — Claude encloses real report summaries in boxes', () => {
      const lines = [
        '╭────────────────────────────╮',
        '│ Here is the summary text   │',
        '╰────────────────────────────╯',
      ];
      const isChrome = chromeRows(fakeReader(lines), 0, 2, DEFAULT_CHROME_MARKERS);
      // The boxed content must be capturable, not skipped as furniture.
      expect(isChrome(1)).toBe(false);
    });
  });
});
