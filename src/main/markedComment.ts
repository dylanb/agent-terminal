import { runAppCommand } from './appCommand';
import { isRecord } from './yamlRecord';

/** The repository a marked comment lives in, as `gh api` names it: origin's host, owner and name. */
export interface CommentRepository {
  host: string;
  owner: string;
  name: string;
}

const markedCommentBody = (marker: string, content: string): string => `${marker}\n${content}`;

/** The length, as GitHub measures a body, of the comment `upsert` sends for `content` under `marker`. */
export function markedCommentLength(marker: string, content: string): number {
  return markedCommentBody(marker, content).length;
}

// Listing whole bodies overflows runAppCommand's 1 MiB output buffer on a PR with long comments.
const lookupJq = (marker: string): string => `.[] | {id, login: .user.login, marked: (.body | startswith(${JSON.stringify(marker)}))}`;

export interface CommentAuthor {
  /** Edits this user's comment on issue or PR `issue` that carries `marker`, or creates one, holding `content`
   *  under the hidden marker. */
  upsert(issue: number, marker: string, content: string): Promise<void>;
}

export interface MarkedComments {
  /** The logged-in user, read before any comment is written. */
  author(): Promise<CommentAuthor>;
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
    async author() {
      const user: unknown = JSON.parse(await api(['user']));
      if (!isRecord(user) || typeof user.login !== 'string') throw new Error('gh api user did not name the logged-in user');
      const login = user.login;
      return {
        async upsert(issue, marker, content) {
          const body = JSON.stringify({ body: markedCommentBody(marker, content) });
          const found = await earlier(issue, login, marker);
          if (found === null) await api(['--method', 'POST', await route(`issues/${issue}/comments`), '--input', '-'], body);
          else await api(['--method', 'PATCH', await route(`issues/comments/${found}`), '--input', '-'], body);
        },
      };
    },
  };
}
