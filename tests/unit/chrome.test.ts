import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CHROME_MARKERS,
  isChromeLine,
  isRuleLine,
  leadingMarker,
  learnMarkers,
} from '../../src/main/chrome';

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
});
