import { describe, expect, it } from 'vitest';
import { parseTodoTemplate } from '../../src/main/todoTemplate';

// §21.2 — a todo template is a markdown list. `parseTodoTemplate` maps each TOP-LEVEL list item
// to one todo text; `[ ]`/`[x]` checkbox markers are ignored; nested sub-bullets and indented
// wrapped lines fold into their item; headings and col-0 prose are ignored (so a template can
// carry a title + instructions). Tests assert only the returned texts — the observable contract.

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

  it('returns no todos for a template with no list items', () => {
    expect(parseTodoTemplate('# Title\n\nJust prose, no list.')).toEqual([]);
    expect(parseTodoTemplate('')).toEqual([]);
  });

  it('drops empty items (bare bullet / empty checkbox / whitespace) so no blank todo is created', () => {
    // A bullet with no text would otherwise persist as a blank row.
    expect(parseTodoTemplate('-\n- [ ]\n-   \n- real one')).toEqual(['real one']);
  });

  it('keeps an initially-empty bullet that becomes non-empty after folding a sub-line', () => {
    // The empty top-level item ('- ' with no text) gains text from its indented continuation — it
    // must survive the empty-item filter (filtering happens after folding, not at push time).
    expect(parseTodoTemplate(['- ', '  folded text', '- second'].join('\n'))).toEqual(['folded text', 'second']);
  });
});
