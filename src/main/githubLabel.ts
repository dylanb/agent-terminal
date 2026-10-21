// An existing label is never changed.

/** Runs `gh <args>` pinned to one repository, throwing an error that starts with `failure`. */
export type PinnedGh = (args: string[], failure: string) => Promise<string>;

export type LabelEnsured = 'created' | 'existed';

export async function ensureGithubLabel(gh: PinnedGh, label: string, description?: string): Promise<LabelEnsured> {
  const listed = await gh(['label', 'list', '--search', label, '--limit', '100', '--json', 'name'], 'label lookup failed');
  let names: unknown;
  try {
    names = JSON.parse(listed);
  } catch {
    throw new Error('label lookup failed: the label listing was not recognized');
  }
  if (!Array.isArray(names)) throw new Error('label lookup failed: the label listing was not recognized');
  // GitHub label names are case-insensitive: creating a case-variant of an existing label fails.
  const wanted = label.toLowerCase();
  const present = names.some((n: unknown) =>
    typeof n === 'object' && n !== null && typeof (n as { name?: unknown }).name === 'string' &&
    (n as { name: string }).name.toLowerCase() === wanted);
  if (present) return 'existed';
  await gh(['label', 'create', label, ...(description === undefined ? [] : ['--description', description])], 'label creation failed');
  return 'created';
}
