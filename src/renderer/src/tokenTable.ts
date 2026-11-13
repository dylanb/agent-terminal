import type { FlowTokensView } from '../../shared/ipc';
import { stripDisplayControlChars } from '../../shared/controlChars';
import { TOKEN_KINDS, type KindCell, type RunTokens, type StepTokens, type TokenKind } from '../../shared/tokenCounts';
import { createTokenCount, type TokenCount, type TokenCountValue } from './tokenCount';
import { exactTokens } from './tokenFormat';

export interface TokenTableView {
  steps: readonly string[];
  tokens: FlowTokensView;
}

export interface TokenTable {
  update(view: TokenTableView): void;
  dispose(): void;
}

export const TOKEN_TABLE_NAME = 'Tokens by step';
const KIND_HEADERS: Record<TokenKind, string> = {
  cacheRead: 'Cache read',
  cacheWrite: 'Cache write',
  input: 'Uncached input',
  output: 'Output',
};

const DASH: TokenCountValue = { shown: 'dash' };

function cellValue(totals: StepTokens | RunTokens | null, kind: TokenKind, counting: boolean): TokenCountValue {
  if (totals === null) return DASH;
  if (totals.state === 'unavailable') return { shown: 'unavailable', counting };
  const cell: KindCell = totals.kinds[kind];
  const incomplete = 'someStepsUnavailable' in totals && totals.someStepsUnavailable;
  return cell.reported === 'none'
    ? { shown: 'not reported', counting, incomplete }
    : { shown: 'count', text: exactTokens(cell.n), counting, partly: cell.reported === 'some', incomplete };
}

type RowCounts = Record<TokenKind, TokenCount>;

export function createTokenTable(host: HTMLElement): TokenTable {
  const doc = host.ownerDocument;
  let table: HTMLTableElement | null = null;
  let builtFor: string | null = null;
  let stepRows: RowCounts[] = [];
  let runRow: RowCounts | null = null;

  const bodyRow = (section: HTMLTableSectionElement, name: string): RowCounts => {
    const tr = section.insertRow();
    const th = doc.createElement('th');
    th.scope = 'row';
    th.textContent = name;
    tr.append(th);
    const counts = TOKEN_KINDS.map((kind) => [kind, createTokenCount(tr.insertCell())] as const);
    return Object.fromEntries(counts) as RowCounts;
  };

  const build = (steps: readonly string[]): void => {
    table?.remove();
    table = doc.createElement('table');
    table.className = 'token-table';
    table.createCaption().textContent = TOKEN_TABLE_NAME;
    const head = table.createTHead().insertRow();
    for (const label of ['Step', ...TOKEN_KINDS.map((kind) => KIND_HEADERS[kind])]) {
      const th = doc.createElement('th');
      th.scope = 'col';
      th.textContent = label;
      head.append(th);
    }
    const body = table.createTBody();
    stepRows = steps.map((name) => bodyRow(body, stripDisplayControlChars(name)));
    runRow = bodyRow(table.createTFoot(), 'Run total');
    host.append(table);
  };

  const show = (row: RowCounts, totals: StepTokens | RunTokens | null, counting: boolean): void => {
    for (const kind of TOKEN_KINDS) row[kind].set(cellValue(totals, kind, counting));
  };

  return {
    update({ steps, tokens }) {
      const key = JSON.stringify(steps);
      if (key !== builtFor) {
        build(steps);
        builtFor = key;
      }
      stepRows.forEach((row, i) => show(row, tokens.steps[i] ?? null, tokens.counting === i));
      if (runRow) show(runRow, tokens.run, false);
    },
    dispose() {
      table?.remove();
      table = null;
      builtFor = null;
      stepRows = [];
      runRow = null;
    },
  };
}
