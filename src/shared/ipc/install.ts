import type { ChannelSpecs, SessionId } from './session';

export const INSTALL_CHANNELS = {
  cliInstall: {
    name: 'cli:install',
    does: 'The renderer asks main to install the agent-terminal launch shim onto PATH for the running build, even before controller registration.',
  },
  installExamplesPreview: {
    name: 'examples:preview',
    does: 'The renderer asks which bundled example files already exist and differ at each destination, without writing anything.',
  },
  installExamplesApply: {
    name: 'examples:apply',
    does: 'The renderer installs the bundled examples, replacing conflicting files only at the destinations the user agreed to.',
  },
} as const satisfies ChannelSpecs;

// ---- CLI launcher install (§23.4 / #25) ----

/** cli:install request (§6): install the `agent-terminal` launch shim onto the user's PATH. Carries
 *  sessionId per §6; no other payload — the install target is computed by main from the running build. */
export interface CliInstallMsg {
  sessionId: SessionId;
}

/** cli:install result: `ok` with the installed command `path`, or `!ok` with a human-readable `error`.
 *  Never a partial state — `ok` is true only when the command is runnable from a new shell. */
export type CliInstallResult =
  | { ok: true; path: string }
  | { ok: false; error: string };

// ---- Install bundled examples (§18.1/§23.4/§27.15) ----

/** §18.1/§23.4/§27.15. */
export const INSTALL_DESTINATION_IDS = [
  'flow',
  'flowCatalog',
  'appLoops',
  'commands',
  'agents',
  'codexLoops',
  'codexAgents',
  'codexSkills',
  'engineGuide',
] as const;

export type InstallDestinationId = (typeof INSTALL_DESTINATION_IDS)[number];
export type InstallPreviewId = string & {
  readonly __installPreviewId: unique symbol;
};

/** examples:preview request (§6): report which bundled files would conflict (exist and differ from
 *  the bundled content), driving the up-front consent step. Carries only sessionId — the bundle
 *  sources and install targets are computed by main from the running build. */
export interface InstallExamplesPreviewMsg {
  sessionId: SessionId;
}

/** One destination's preview. The two modes are mutually exclusive: a destination with no conflict
 *  carries no files and asks the user for no decision, so `files` exists only in the conflicting mode
 *  (CLAUDE.md discriminated-union corollary). */
export type InstallDestinationPreview =
  | { destination: InstallDestinationId; conflict: false }
  | { destination: InstallDestinationId; conflict: true; files: DestRelativePath[] };

/** examples:preview result: `ok` with one entry per destination the action would write, or `!ok` with a
 *  human-readable `error` when the request itself was refused. The error arm is distinct from a clean
 *  `ok` with no conflicts: an empty destination list would otherwise read as "nothing conflicts", so a
 *  refused request could drive an apply the user never consented to. Observing a preview never writes
 *  anything (§18.1). */
export type InstallExamplesPreview =
  | {
      ok: true;
      previewId: InstallPreviewId;
      destinations: InstallDestinationPreview[];
      retired: RetiredExample[];
      /** §18.1: the retired flow the installed fallback flow.yaml still is, or null. */
      retiredFallback: string | null;
      alwaysReplaced: InstallDestinationFiles[];
    }
  | { ok: false; error: string };

/** examples:apply request (§6/§18.1). */
export interface InstallExamplesApplyMsg {
  sessionId: SessionId;
  previewId: InstallPreviewId;
  replace: InstallDestinationId[];
  removeRetired: boolean;
}

/** §18.1. `rel` is one entry directly under the destination's root: a whole folder or a single file. */
export interface RetiredExample {
  destination: InstallDestinationId;
  rel: DestRelativePath;
}

/** A file's path relative to the root of the destination it installs under. A plain `string` is not
 *  assignable to it, so every value is minted at one checked place (`destRelative`) — an absolute path or
 *  one escaping its destination is refused there rather than travelling as a legal-looking value. */
export type DestRelativePath = string & { readonly __destRelative: unique symbol };

/** Files reported under the destination they were written to, so two destinations sharing a file name
 *  yield two distinct, attributable entries. */
export interface InstallDestinationFiles {
  destination: InstallDestinationId;
  files: DestRelativePath[];
}

/** The files an apply touched, grouped by the destination each was written to (§18.1). `skipped` is
 *  "left byte-for-byte unchanged" — either the target already matched the bundle, or it differed and the
 *  user did not consent to replace in that destination. A write the safe-path primitive refuses
 *  (symlinked container, CWE-59) is an `error`, never a silent skip. */
export interface InstallExamplesWritten {
  created: InstallDestinationFiles[];
  overwritten: InstallDestinationFiles[];
  skipped: InstallDestinationFiles[];
}

/** A destination skipped because the tool it installs for is absent: `root` is that tool's home, which does
 *  not exist (§18.1). */
export interface InstallDestinationNotInstalled {
  destination: InstallDestinationId;
  root: string;
}

export interface InstallExamplesReport extends InstallExamplesWritten {
  notInstalled: InstallDestinationNotInstalled[];
  removed: RetiredExample[];
}

/** examples:apply result: `ok`, or `!ok` with a human-readable `error`. Both arms carry the same report:
 *  the action does not roll back a write that already landed, so a failure names exactly what it wrote —
 *  and what it left alone — before failing. The report is empty when the install was refused before any
 *  write, which is the all-or-nothing case. */
export type InstallExamplesResult =
  | ({ ok: true } & InstallExamplesReport)
  | ({ ok: false; error: string } & InstallExamplesReport);

/** CLI launcher install (§23.4 / #25): the settings affordance's only seam to the install action. */
export interface CliApi {
  /** Install the `agent-terminal` launch shim onto PATH, reconciling to the running build. */
  install(): Promise<CliInstallResult>;
}

/** Install bundled examples (§18.1/§23.4/§27.15): the settings organism's only seam to the install action.
 *  Observing a preview never writes anything. */
export interface ExamplesApi {
  preview(): Promise<InstallExamplesPreview>;
  apply(
    previewId: InstallPreviewId,
    replace: InstallDestinationId[],
    removeRetired: boolean,
  ): Promise<InstallExamplesResult>;
}
