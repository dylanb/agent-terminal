// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { createTodoTab } from '../../src/renderer/src/todoTab';
import type { TodoItem } from '../../src/shared/ipc';

it('keeps an unfinished inline edit and its selection when the todo list refreshes', async () => {
  document.body.innerHTML = '<div id="list"></div><span id="count"></span>';
  const host = document.getElementById('list')!;
  const items: TodoItem[] = [{ id: 'one', repoKey: '/repo', text: 'original', status: 'active', order: 1, createdAt: '' }];
  const tab = createTodoTab({ todoListEl: host, todoCountEl: document.getElementById('count')!, doInject: () => {}, monitor: {
    todoList: async () => items, todoAdd: async () => items, todoUpdate: async () => items,
    todoReorder: async () => items, todoSetStatus: async () => items, todoDelete: async () => items,
    listTemplates: async () => ({ templates: [] }), instantiateTemplate: async () => items,
  } });
  tab.onRepoChanged('/repo');
  await new Promise(resolve => setTimeout(resolve, 0));
  host.querySelector<HTMLButtonElement>('.todo-edit')!.click();
  const editor = host.querySelector<HTMLElement>('[role="textbox"]')!;
  editor.textContent = 'unfinished draft';
  editor.focus();
  document.getSelection()!.setBaseAndExtent(editor.firstChild!, 2, editor.firstChild!, 7);
  tab.refresh();
  await new Promise(resolve => setTimeout(resolve, 0));
  const current = host.querySelector<HTMLElement>('[role="textbox"]')!;
  expect(current.textContent).toBe('unfinished draft');
  expect(document.activeElement).toBe(current);
  expect(document.getSelection()!.toString()).toBe('finis');
  document.body.innerHTML = '';
  document.getSelection()?.removeAllRanges();
});

async function refreshFixture(add?: (text: string) => Promise<TodoItem[]>) {
  document.body.innerHTML = '<div id="list"></div><span id="count"></span>';
  const host = document.getElementById('list')!;
  let items: TodoItem[] = [{ id: 'one', repoKey: '/repo', text: 'original', status: 'active', order: 1, createdAt: '' }];
  const tab = createTodoTab({ todoListEl: host, todoCountEl: document.getElementById('count')!, doInject: () => {}, monitor: {
    todoList: async () => items,
    todoAdd: async (_repo, text) => add ? add(text) : (items = [...items, { id: 'new', repoKey: '/repo', text, status: 'active', order: 2, createdAt: '' }]),
    todoUpdate: async () => items, todoReorder: async () => items, todoSetStatus: async () => items, todoDelete: async () => items,
    listTemplates: async () => ({ templates: [] }), instantiateTemplate: async () => items,
  } });
  tab.onRepoChanged('/repo'); await new Promise(resolve => setTimeout(resolve, 0));
  return { host, tab, items: () => items, refresh: async (next: TodoItem[]) => { items = next; tab.refresh(); await new Promise(resolve => setTimeout(resolve, 0)); } };
}

it('keeps a remotely deleted edit recoverable and saves it as a new todo only on request', async () => {
  const f = await refreshFixture();
  f.host.querySelector<HTMLButtonElement>('.todo-edit')!.click();
  const editor = f.host.querySelector<HTMLElement>('[role="textbox"]')!;
  editor.textContent = 'recover this draft'; editor.focus();
  await f.refresh([]);
  const retained = f.host.querySelector<HTMLElement>('[role="textbox"]');
  expect(retained?.textContent).toBe('recover this draft');
  expect(document.activeElement).toBe(retained);
  expect(f.items()).toEqual([]);
  f.host.querySelector<HTMLButtonElement>('.todo-save')!.click();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(f.items().map(item => ({ id: item.id, text: item.text }))).toEqual([{ id: 'new', text: 'recover this draft' }]);
});

it('lands focus on the new-todo input when a remotely deleted row held focus', async () => {
  const f = await refreshFixture();
  f.host.querySelector<HTMLButtonElement>('.todo-edit')!.focus();
  await f.refresh([]);
  expect(document.activeElement).toBe(f.host.querySelector('#todo-new'));
});

it.each([false, true])('Add reply after a push clears only the submitted draft (new typing: %s)', async newer => {
  let settle!: (items: TodoItem[]) => void;
  const f = await refreshFixture(() => new Promise(resolve => { settle = resolve; }));
  const input = f.host.querySelector<HTMLTextAreaElement>('#todo-new')!;
  input.value = 'submitted task'; input.focus();
  f.host.querySelector<HTMLButtonElement>('#todo-add-btn')!.click();
  await f.refresh(f.items());
  if (newer) f.host.querySelector<HTMLTextAreaElement>('#todo-new')!.value = 'newer typing';
  settle(f.items()); await new Promise(resolve => setTimeout(resolve, 0));
  expect(f.host.querySelector<HTMLTextAreaElement>('#todo-new')!.value).toBe(newer ? 'newer typing' : '');
});

it('keeps keyboard focus usable when remote completion disables the focused Edit control', async () => {
  const f = await refreshFixture();
  f.host.querySelector<HTMLButtonElement>('.todo-edit')!.focus();
  await f.refresh(f.items().map(item => ({ ...item, status: 'done' })));
  expect(document.activeElement).toBe(f.host.querySelector('#todo-new'));
});

it('keeps keyboard focus usable when remote reorder disables the focused Move down control', async () => {
  const f = await refreshFixture();
  const first = f.items()[0]; const second = { ...first, id: 'two', text: 'second', order: 2 };
  await f.refresh([first, second]);
  f.host.querySelector<HTMLButtonElement>('[data-todo-id="one"] .todo-down')!.focus();
  await f.refresh([{ ...second, order: 1 }, { ...first, order: 2 }]);
  expect(document.activeElement).toBe(f.host.querySelector('#todo-new'));
});
