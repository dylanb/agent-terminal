import { runAppCommand } from './appCommand';
import { isRecord } from './yamlRecord';

/** The repository a marked comment lives in, as `gh api` names it: origin's host, owner and name. */
export interface CommentRepository {
  host: string;
  owner: string;
  name: string;
}

/** The comment body sent for `content` under `marker`: the marker on its own first line, hidden when rendered. */
export function markedCommentBody(marker: string, content: string): string {
  return `${marker}\n${content}`;
}

// Listing whole bodies overflows runAppCommand's 1 MiB output buffer on a PR with long comments.
const lookupJq = (marker: string): string => `.[] | {id, login: .user.login, marked: (.body | startswith(${JSON.stringify(marker)}))}`;

export interface MarkedComments {
  /** The logged-in user's login. */
  login(): Promise<string>;
  /** Edits `login`'s comment on issue or PR `issue` whose body starts with `marker`, or creates one, sending
   *  exactly `markedCommentBody(marker, content)` on stdin. */
  upsert(issue: number, login: string, marker: string, content: string): Promise<void>;
}

export function createMarkedComments(cwd: string, repository: () => Promise<CommentRepository>): MarkedComments {
  const api = async (args: string[], stdin?: string): Promise<string> => {
    const { host } = await repository();
    return runAppCommand('gh', ['api', '--hostname', host, ...args], cwd, stdin);
  };
  const route = async (path: string): Promise<string> => {
    const { owner, name } = await repository();
    return `repos/${owner}/${name}/${path}`;
  };
  const earlier = async (issue: number, login: string, marker: string): Promise<number | null> => {
    const listed = await api(['--paginate', '--jq', lookupJq(marker), `${await route(`issues/${issue}/comments`)}?per_page=100`]);
    for (const line of listed.split('\n')) {
      if (line === '') continue;
      const comment: unknown = JSON.parse(line);
      if (!isRecord(comment) || !Number.isSafeInteger(comment.id) || typeof comment.login !== 'string' || typeof comment.marked !== 'boolean') {
        throw new Error(`a comment on #${issue} could not be read`);
      }
      if (comment.login === login && comment.marked) return comment.id as number;
    }
    return null;
  };
  return {
    async login() {
      const user: unknown = JSON.parse(await api(['user']));
      if (!isRecord(user) || typeof user.login !== 'string') throw new Error('gh api user did not name the logged-in user');
      return user.login;
    },
    async upsert(issue, login, marker, content) {
      const body = JSON.stringify({ body: markedCommentBody(marker, content) });
      const found = await earlier(issue, login, marker);
      if (found === null) await api(['--method', 'POST', await route(`issues/${issue}/comments`), '--input', '-'], body);
      else await api(['--method', 'PATCH', await route(`issues/comments/${found}`), '--input', '-'], body);
    },
  };
}
