import type { ChannelSpecs, SessionId } from './session';

export const TODO_CHANNELS = {
  todoList: {
    name: 'todo:list',
    does: "The renderer reads the current repo's todos in order.",
  },
  todoAdd: {
    name: 'todo:add',
    does: 'The renderer appends a todo and gets the fresh list back.',
  },
  todoUpdate: {
    name: 'todo:update',
    does: 'The renderer saves an edit to a todo and gets the fresh list back.',
  },
  todoReorder: {
    name: 'todo:reorder',
    does: 'The renderer saves a new order for the active todos and gets the fresh list back.',
  },
  todoSetStatus: {
    name: 'todo:setStatus',
    does: 'The renderer sets a todo to active, in progress or done and gets the fresh list back.',
  },
  todoDelete: {
    name: 'todo:delete',
    does: 'The renderer removes a todo and gets the fresh list back.',
  },
  todoTemplateList: {
    name: 'todoTemplate:list',
    does: "The renderer lists the todo templates offered for the repo's in-progress step, with the step's default template.",
  },
  todoTemplateInstantiate: {
    name: 'todoTemplate:instantiate',
    does: "The renderer adds a named template's items to the repo's todo list, skipping items already there.",
  },
} as const satisfies ChannelSpecs;

// ---- Todo lists (§16.3 / §16.4) ----

// Tri-state lifecycle (§16.3): `active` and `in_progress` are both "outstanding" — they count and
// keep their row actions; only `done` is complete.
export type TodoStatus = 'active' | 'in_progress' | 'done';

export type TodoSourceType = 'manual' | 'selection' | 'report' | 'finding' | 'capture' | 'command-output';

export interface TodoSource {
  type: TodoSourceType;
  /** The source MonitorEvent id, when added from a capture (§16.2). */
  eventId?: string;
}

/**
 * A persistent, repo-scoped todo (§16.3). `order` is the sort key within a status group (active
 * list / Done section).
 */
export interface TodoItem {
  id: string;
  repoKey: string;
  text: string;
  status: TodoStatus;
  order: number;
  createdAt: string;
  source?: TodoSource;
}

export interface TodoListMsg {
  sessionId: SessionId;
  repoKey: string;
}

export interface TodoAddMsg {
  sessionId: SessionId;
  repoKey: string;
  text: string;
  source?: TodoSource;
}

export interface TodoUpdateMsg {
  sessionId: SessionId;
  repoKey: string;
  id: string;
  text: string;
}

export interface TodoReorderMsg {
  sessionId: SessionId;
  repoKey: string;
  orderedIds: string[];
}

export interface TodoSetStatusMsg {
  sessionId: SessionId;
  repoKey: string;
  id: string;
  status: TodoStatus;
}

export interface TodoDeleteMsg {
  sessionId: SessionId;
  repoKey: string;
  id: string;
}

/** A discoverable todo template (§4.1/§21.2): `ref` is the instantiate id (filename without
 *  `.md`); `name` is the user-facing label (its `# H1`, else a humanized filename). */
export interface TodoTemplateRef {
  ref: string;
  name: string;
}

/** todoTemplate:list response (§4.1/§6): the templates offered to the on-demand picker, plus the
 *  active step's bound `todo_template:` as the picker's default selection. Main gates this to a
 *  step that is `in_progress` (empty otherwise), so the todo widget needs no flow-state awareness. */
export interface TodoTemplateList {
  templates: TodoTemplateRef[];
  defaultRef?: string;
}

/** todoTemplate:list request (§6): the templates co-located with the repo's flow.yaml (§18.6).
 *  `repoKey` resolves the flow dir local-first-then-global (deviates from the v2.27 global-only
 *  sketch, since templates are now co-located). */
export interface TodoTemplateListMsg {
  sessionId: SessionId;
  repoKey: string;
}

/** todoTemplate:instantiate request (§6/§21.2): instantiate the named template `ref` (resolved
 *  co-located with the flow.yaml, §18.6) into `repoKey`'s todo list, returning the fresh list. */
export interface TodoTemplateInstantiateMsg {
  sessionId: SessionId;
  repoKey: string;
  ref: string;
}
