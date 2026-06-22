import { describe, expect, it } from 'vitest';
import { parseTodoTemplate } from '../../src/main/todoTemplate';

// §21.2 — todo-template (markdown list) parse contract.

describe('parseTodoTemplate (§21.2)', () => {
  it('maps each top-level list item to one todo text', () => {
    expect(parseTodoTemplate('- first\n- second\n- third')).toEqual(['first', 'second', 'third']);
  });

  it('accepts -, *, and + bullets alike', () => {
    expect(parseTodoTemplate('- dash\n* star\n+ plus')).toEqual(['dash', 'star', 'plus']);
  });

  it('strips a leading checkbox marker, done or not', () => {
    expect(parseTodoTemplate('- [ ] todo one\n- [x] done two')).toEqual(['todo one', 'done two']);
  });

  it('folds nested sub-bullets and indented wrapped lines into their top-level item', () => {
    const md = ['- first item', '  with a wrapped line', '  - and a sub bullet', '- second item'].join('\n');
    expect(parseTodoTemplate(md)).toEqual(['first item with a wrapped line and a sub bullet', 'second item']);
  });

  it('ignores headings and col-0 prose, before and between list items', () => {
    const md = [
      '# Grooming checklist',
      'Some intro instructions.',
      '',
      '- first item',
      '- second item',
      '',
      'Trailing note, not a todo.',
      '- third item',
    ].join('\n');
    expect(parseTodoTemplate(md)).toEqual(['first item', 'second item', 'third item']);
  });

  it('drops empty items so a bare marker or empty checkbox makes no blank todo', () => {
    expect(parseTodoTemplate('- first\n- \n- [ ] \n- second')).toEqual(['first', 'second']);
  });

  it('returns no todos for a template with no list items', () => {
    expect(parseTodoTemplate('# Title\n\nJust prose, no list.')).toEqual([]);
    expect(parseTodoTemplate('')).toEqual([]);
  });
});
