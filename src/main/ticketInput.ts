import { errMsg } from './errno';
import { inGitHubRepository, matchesGitHubRepositoryUrl, type GitHubRepositoryIdentity } from './githubRepository';
import { isIssueNumber } from '../shared/issueNumber';
import type { FlowPrompt } from '../shared/ipc';
import { BOOTSTRAP_PICKUP } from './flowEntryActions';

export type TicketRepository = Pick<GitHubRepositoryIdentity, 'selector' | 'owner' | 'name'>;

export type TicketRefusalReason = 'not-an-issue-number' | 'not-an-issue-url' | 'origin-unavailable' | 'other-repository';

export type TicketInputNormalization =
  | { ok: true; values: Record<string, string> }
  | { ok: false; input: string; reason: TicketRefusalReason; notice: string };

type StepInputs = { inputs?: readonly { name: string; type: string }[] };

export function stepInputTypes(step: StepInputs | undefined): Record<string, string> {
  const map: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const input of step?.inputs ?? []) map[input.name] = input.type;
  return map;
}

function looksLikeUrl(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value);
}

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function issueNumberOf(parsed: URL): number | null {
  const last = parsed.pathname.split('/').filter(Boolean).at(-1) ?? '';
  return isIssueNumber(last) ? Number(last) : null;
}

function refuse(input: string, reason: TicketRefusalReason, notice: string): TicketInputNormalization {
  return { ok: false, input, reason, notice };
}

export async function normalizeTicketInputs(
  values: Record<string, string>,
  types: Record<string, string>,
  currentRepository: () => Promise<TicketRepository>,
): Promise<TicketInputNormalization> {
  const normalized: Record<string, string> = { ...values };
  for (const [key, raw] of Object.entries(values)) {
    if (!Object.prototype.hasOwnProperty.call(types, key) || types[key] !== 'github-ticket') continue;
    const value = raw.trim();
    if (!looksLikeUrl(value)) {
      if (!isIssueNumber(value)) {
        return refuse(key, 'not-an-issue-number', `"${value}" is not an issue number. Enter an issue number or an issue URL.`);
      }
      Object.defineProperty(normalized, key, { value, enumerable: true, writable: true, configurable: true });
      continue;
    }
    const parsed = parseUrl(value);
    const notIssueUrl = `"${value}" is not a GitHub issue URL. Enter an issue number or an issue URL.`;
    if (parsed === null) return refuse(key, 'not-an-issue-url', notIssueUrl);
    parsed.search = '';
    parsed.hash = '';
    let repo: TicketRepository;
    try {
      repo = await currentRepository();
    } catch (e) {
      return refuse(
        key,
        'origin-unavailable',
        `Cannot check that "${value}" belongs to this repository: ${errMsg(e)}. Enter the issue number instead.`,
      );
    }
    const issue = issueNumberOf(parsed);
    if (issue !== null && matchesGitHubRepositoryUrl(parsed.href, repo, 'issues', issue)) {
      Object.defineProperty(normalized, key, { value: String(issue), enumerable: true, writable: true, configurable: true });
      continue;
    }
    if (inGitHubRepository(parsed, repo)) return refuse(key, 'not-an-issue-url', notIssueUrl);
    return refuse(
      key,
      'other-repository',
      `"${value}" is not an issue in this repository (${repo.owner}/${repo.name}). Open a terminal in the issue's repository to work on it, or enter an issue number from this one.`,
    );
  }
  return { ok: true, values: normalized };
}

export type TicketSubmission =
  | { kind: 'accepted'; values: Record<string, string> }
  | { kind: 'refused'; notice: string; prompt: FlowPrompt }
  | { kind: 'stale' };

export async function submitTicketInputs(
  values: Record<string, string>,
  step: StepInputs | undefined,
  deps: { currentRepository: () => Promise<TicketRepository>; entryToken: () => number | undefined },
): Promise<TicketSubmission> {
  const token = deps.entryToken();
  const result = await normalizeTicketInputs(values, stepInputTypes(step), deps.currentRepository);
  if (deps.entryToken() !== token) return { kind: 'stale' };
  if (result.ok) return { kind: 'accepted', values: result.values };
  const inputs = (step?.inputs ?? [])
    .filter((i) => Object.prototype.hasOwnProperty.call(values, i.name))
    .map(({ name, type }) => ({ name, type }));
  return {
    kind: 'refused',
    notice: result.notice,
    prompt: { inputs, bootstrap: BOOTSTRAP_PICKUP, refusal: { input: result.input, notice: result.notice, values } },
  };
}
