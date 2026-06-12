import { describe, expect, it } from 'vitest';
import { cleanSelectionText, createSelectionModel } from '../../src/renderer/src/selectionModel';

describe('cleanSelectionText (§7.5)', () => {
  it('trims trailing spaces and tabs per line (cell padding)', () => {
    expect(cleanSelectionText('foo   \nbar\t\t\nbaz')).toBe('foo\nbar\nbaz');
  });

  it('drops exactly one trailing newline (no auto-submit)', () => {
    expect(cleanSelectionText('cmd\n')).toBe('cmd');
    expect(cleanSelectionText('a\n\n')).toBe('a\n');
    expect(cleanSelectionText('a\r\n')).toBe('a');
  });

  it('preserves leading whitespace and interior blank lines', () => {
    expect(cleanSelectionText('  indented\n\n  more  ')).toBe('  indented\n\n  more');
  });
});

describe('selection model (§7.2–7.3)', () => {
  const gesture = {
    range: { start: { x: 2, y: 10 }, end: { x: 7, y: 12 } },
    text: 'selected text',
    baseY: 5,
    bufferType: 'normal' as const,
  };

  it('a non-empty gesture populates the model', () => {
    const model = createSelectionModel();
    expect(model.update(gesture)).toBe(true);
    const s = model.get();
    expect(s.active).toBe(true);
    expect(s.start).toEqual({ x: 2, y: 10 });
    expect(s.end).toEqual({ x: 7, y: 12 });
    expect(s.text).toBe('selected text');
    expect(s.baseY).toBe(5);
    expect(s.bufferType).toBe('normal');
  });

  it('ignores empty updates — blur-clears never erase the selection (§7.3)', () => {
    const model = createSelectionModel();
    model.update(gesture);
    expect(model.update({ range: undefined, text: '', baseY: 0, bufferType: 'normal' })).toBe(false);
    expect(model.update({ range: gesture.range, text: '', baseY: 0, bufferType: 'normal' })).toBe(false);
    expect(model.get().active).toBe(true);
    expect(model.get().text).toBe('selected text');
  });

  it('a new non-empty gesture replaces the previous selection', () => {
    const model = createSelectionModel();
    model.update(gesture);
    model.update({ ...gesture, text: 'other', baseY: 9, bufferType: 'alternate' });
    expect(model.get().text).toBe('other');
    expect(model.get().bufferType).toBe('alternate');
  });

  it('only an explicit clear resets the model (§7.5.1)', () => {
    const model = createSelectionModel();
    model.update(gesture);
    model.clear();
    const s = model.get();
    expect(s.active).toBe(false);
    expect(s.start).toBeNull();
    expect(s.end).toBeNull();
    expect(s.text).toBe('');
  });
});
