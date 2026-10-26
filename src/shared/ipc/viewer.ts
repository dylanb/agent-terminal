import type { ChannelSpecs, SessionId } from './session';

export const VIEWER_CHANNELS = {
  viewerTree: {
    name: 'viewer:tree',
    does: "The renderer asks for the repo's artifact tree, either the curated set or the whole repo.",
  },
  viewerRead: {
    name: 'viewer:read',
    does: 'The renderer reads one file for the artifact viewer, getting null when it is missing, binary, too large or outside the tree.',
  },
  viewerOnChanged: {
    name: 'viewer:onChanged',
    does: "Main reports that a file under the viewer's tree changed on disk, so the viewer re-reads it.",
  },
} as const satisfies ChannelSpecs;

// ---- Artifact viewer (§20.1/§20.2) ----

/** Per-file provenance tags (D8): tracked-but-changed in the working tree, under the
 *  §27 loop tree (`.agent-terminal/loop/`), or part of the current PR. Empty/omitted when none apply. */
export type ArtifactProvenance = 'changed' | 'loop' | 'pr';

/** One node of the hierarchical artifact tree (§20.1). A directory carries `children`;
 *  a file carries its `provenance` tags. `relPath` is unique within a tree and is the
 *  id the renderer passes back to `viewer:read`. */
export interface ArtifactNode {
  name: string;
  relPath: string;
  kind: 'file' | 'dir';
  children?: ArtifactNode[];
  provenance?: ArtifactProvenance[];
}

/** Curated (loop ∪ PR ∪ working-tree changes) vs. the whole repo (D8). */
export type ArtifactScope = 'curated' | 'repo';

/** viewer:onChanged broadcast (§20.1): main signals that a file under the viewer's tree root changed
 *  on disk; the viewer re-pulls `viewer:tree`/`viewer:read`. Payload-free beyond the session — the
 *  viewer re-discovers against its own live cwd, mirroring flow:onStateChanged. */
export interface ViewerChangedMsg {
  sessionId: SessionId;
}

export interface ArtifactTree {
  /** Absolute discovery root: the repo root, or the cwd when outside a repo. */
  root: string;
  /** False outside a git repo — the tree is the whole cwd dir, no curated scope/provenance. */
  isRepo: boolean;
  scope: ArtifactScope;
  nodes: ArtifactNode[];
}

export type ViewerFileKind = 'markdown' | 'code';

export interface ViewerFile {
  relPath: string;
  name: string;
  kind: ViewerFileKind;
  lang?: string;
  body: string;
  /** 1-based current-file lines added/modified vs the PR base (else HEAD; code files in a repo; §20.2). Absent when none. */
  changedLines?: number[];
}

export interface ViewerTreeMsg {
  sessionId: SessionId;
  scope: ArtifactScope;
}

export interface ViewerReadMsg {
  sessionId: SessionId;
  relPath: string;
}

/** Artifact viewer (§20): real, context-connected discovery + file read. Talks only to
 *  the main process (the widget never touches the fs directly), keeping it relocatable. */
export interface ViewerApi {
  /** Discover the current repo's artifact tree (§20.1); outside a repo, the whole cwd tree. */
  tree(scope: ArtifactScope): Promise<ArtifactTree>;
  /** Read one file by its tree-relative path; null when missing, binary, or too large. */
  read(relPath: string): Promise<ViewerFile | null>;
  /** Subscribe to main's viewer:onChanged push (§20.1): `cb` fires when a file under the viewer's
   *  tree root changes on disk, prompting a `tree()`/`read()` re-pull. Returns an unsubscribe. */
  onChanged(cb: () => void): () => void;
}
