# Syncing between agent-terminal and software-factory

[dylanb/agent-terminal](https://github.com/dylanb/agent-terminal) (public) and software-factory (internal) share history, and changes move between them in both directions. A sync is a fast-forward or a merge, never a hand-copied diff.

## Sync records

Each repository a clone pulls from is a **sync source** with a record in `sync/<source>.json`:

| Field | Meaning |
| --- | --- |
| `remote` | The git remote name the source is fetched through. |
| `branch` | The source branch synced from. |
| `url` | The source's clone URL, used when its location can be public. |
| `urlEnv` | Used instead of `url` for a private source: the name of an env var holding its clone URL. |
| `lastSync.commit` | The last source commit pulled in. |
| `lastSync.syncedAt` | The date it was pulled in. |

The records are per source, so both repos carry both files without conflict:

- `sync/agent-terminal.json` records what software-factory last pulled from agent-terminal.
- `sync/software-factory.json` records what agent-terminal last pulled from software-factory.

`git log -p sync/<source>.json` gives the history of syncs from that source.

## Private source URL

software-factory is internal, so its record carries `"urlEnv": "SOFTWARE_FACTORY_URL"` and the URL appears nowhere in the public repo.

- **Locally:** set it in the repo-root `.env` (gitignored), or add a git remote named `software-factory` yourself. An existing remote takes precedence.

  ```sh
  SOFTWARE_FACTORY_URL=<clone URL of the internal software-factory repository>
  ```

- **In Actions:** set the repository secret `SOFTWARE_FACTORY_URL` on dylanb/agent-terminal to an HTTPS URL carrying a read-only token for the internal repo, e.g. `https://x-access-token:<token>@github.com/<owner>/software-factory.git`:

  ```sh
  gh secret set SOFTWARE_FACTORY_URL --repo dylanb/agent-terminal
  ```

The `sync-status` workflow (weekly, or run by hand) writes each source's count of unpulled commits to its job summary. It prints counts only, because a public repo's Actions logs are public. A source without its secret is reported as not configured.

## Procedure

```sh
pnpm sync:status <source>                    # fetches the source; lists commits and files since lastSync
git checkout -b sync/<source>-<date> main
git merge <remote>/main                      # fast-forwards when this repo has no unsynced commits of its own
pnpm sync:record <source>                    # sets lastSync to <remote>/main and today's date
git add sync/<source>.json && git commit -m "Record sync from <source> [skip ci]"
gh pr create --draft
```

`node scripts/sync.mjs list` shows every source's last sync. Run the test suites and `pnpm run test:proof` on the PR as for any other change ([test-proof.md](test-proof.md)).

Don't name a sync remote `upstream`. `gh` targets a remote with that name by default, so `gh pr create` would open the PR against the other repository.
