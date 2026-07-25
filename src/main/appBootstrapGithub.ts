import { errMsg } from './errno';
import { numberFromGithubUrl } from '../shared/githubUrl';
import { run } from './appBootstrapCommand';
import {
  AmbiguousBootstrapOperationError,
  type AppBootstrapGitHub,
  type OwnedPrLookup,
} from './bootstrapPorts';

function ghStringSliceItem(value: string): string {
  return /[",\r\n]/.test(value)
    ? `"${value.replaceAll('"', '""')}"`
    : value;
}

function parseOwnedPrLookup(out: string, marker: string): OwnedPrLookup {
  let parsed: unknown;
  try {
    parsed = JSON.parse(out);
  } catch {
    throw new Error('draft PR reconciliation returned invalid data');
  }
  if (!Array.isArray(parsed)) throw new Error('draft PR reconciliation returned invalid data');
  const candidates = parsed.map((item): { number: number; body: string; isDraft: boolean } => {
    if (
      typeof item !== 'object' ||
      item === null ||
      !Number.isSafeInteger((item as { number?: unknown }).number) ||
      (item as { number: number }).number <= 0 ||
      typeof (item as { body?: unknown }).body !== 'string' ||
      typeof (item as { isDraft?: unknown }).isDraft !== 'boolean'
    ) {
      throw new Error('draft PR reconciliation returned invalid data');
    }
    return item as { number: number; body: string; isDraft: boolean };
  });
  const matches = candidates.filter(
    (item) => item.isDraft && item.body.includes(marker),
  );
  if (matches.length > 1) throw new Error('draft PR reconciliation found multiple owned candidates');
  if (matches.length === 1) return { kind: 'owned', number: matches[0].number };
  return candidates.length === 0 ? { kind: 'absent' } : { kind: 'foreign' };
}

export function createRealAppBootstrapGitHub(repoDir: string): AppBootstrapGitHub {
  const gh = (args: string[], failure: string): Promise<string> =>
    run('gh', args, repoDir, failure);
  return {
    viewIssue: async (issue) => {
      try {
        const parsed = JSON.parse(
          await gh(
            ['issue', 'view', String(issue), '--json', 'title,url'],
            'issue lookup failed',
          ),
        );
        if (typeof parsed?.title === 'string' && typeof parsed?.url === 'string') {
          return { title: parsed.title, url: parsed.url };
        }
        return null;
      } catch {
        return null;
      }
    },
    assignIssueToSelf: async (issue) =>
      void (await gh(
        ['issue', 'edit', String(issue), '--add-assignee', '@me'],
        'issue assignment failed',
      )),
    setIssueLabel: async (issue, label, on) =>
      void (await gh(
        [
          'issue',
          'edit',
          String(issue),
          on ? '--add-label' : '--remove-label',
          ghStringSliceItem(label),
        ],
        'issue label update failed',
      )),
    createDraftPr: async ({ base, head, title, body }) => {
      let out: string;
      try {
        out = await gh(
          ['pr', 'create', '--draft', '--base', base, '--head', head, '--title', title, '--body', body],
          'draft PR creation failed',
        );
      } catch (e) {
        throw new AmbiguousBootstrapOperationError(errMsg(e));
      }
      const number = numberFromGithubUrl(out);
      if (number === null) {
        throw new AmbiguousBootstrapOperationError('draft PR creation outcome was not recognized');
      }
      // TODO(dylanb): the printed URL's repository is not checked against the resolved origin, so a `gh`
      // that returns another repository's PR URL yields a number this app then labels and marks ready.
      // Closing it means resolving the repository here and treating a mismatch as an ambiguous outcome.
      return number;
    },
    findOwnedOpenPr: async ({ base, head, marker }) => {
      const out = await gh(
        [
          'pr',
          'list',
          '--state',
          'open',
          '--base',
          base,
          '--head',
          head,
          '--limit',
          '100',
          '--json',
          'number,body,isDraft',
        ],
        'draft PR reconciliation failed',
      );
      return parseOwnedPrLookup(out, marker);
    },
    closePr: async (pr) =>
      void (await gh(
        ['pr', 'close', String(pr)],
        'draft PR rollback failed',
      )),
    setPrLabel: async (pr, label, on) =>
      void (await gh(
        [
          'pr',
          'edit',
          String(pr),
          on ? '--add-label' : '--remove-label',
          ghStringSliceItem(label),
        ],
        'PR label update failed',
      )),
  };
}

