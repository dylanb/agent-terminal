// What a GitHub repository selector (`host/owner/name`) is, shared by the main process's repository identity and
// the bench fixture, so a selector one accepts the other cannot refuse.

export const REPOSITORY_PART = /^[A-Za-z0-9_.][A-Za-z0-9_.-]*$/;

export function validGitHubRepositorySelector(value: string): boolean {
  const parts = value.split('/');
  return (
    parts.length === 3 &&
    parts.every(
      (part) =>
        REPOSITORY_PART.test(part) && part !== '.' && part !== '..',
    )
  );
}
