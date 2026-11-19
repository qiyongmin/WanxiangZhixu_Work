import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Kanban, { columnOf, groupByStatus } from '../src/components/tasks/Kanban';
import { moveTask, type MoveDeps, type MoveSubject } from '../src/lib/moveTask';
import { getEntry, setData } from '../src/lib/queryCache';
import { resetNotices } from '../src/lib/notice';
import { STATUSES, type TasksView } from '../src/lib/types';
import { click, flush, key, render } from './helpers';
import { byText, fail, row, stubFetch } from './p2';

afterEach(() => {
  vi.unstubAllGlobals();
  resetNotices();
});

const subject = (extra: Partial<MoveSubject> = {}): MoveSubject => ({
  id: 't1',
  status: 'Planned',
  revision: 4,
  openChildCount: 0,
  ...extra,
});

function deps(overrides: Partial<MoveDeps> = {}) {
  const applied: Array<[string, string, number]> = [];
  const notices: string[] = [];
  const full: MoveDeps = {
    confirmDone: vi.fn(async () => true),
    send: vi.fn(async () => ({ revision: 5 })),
    apply: (id, status, revision) => applied.push([id, status, revision]),
    notify: (message) => notices.push(message),
    ...overrides,
  };
  return { full, applied, notices };
}

describe('moveTask：统一移动逻辑', () => {
  it('释放在原列或列外：不发请求', async () => {
    const { full, applied } = deps();
    expect(await moveTask(subject(), 'Planned', full)).toBe('noop');
    expect(await moveTask(subject(), null, full)).toBe('noop');
    expect(full.send).not.toHaveBeenCalled();
    expect(applied).toEqual([]);
  });

  it('普通移动：乐观移动，成功后以响应 revision 提交', async () => {
    const { full, applied } = deps();
    expect(await moveTask(subject(), 'In Progress', full)).toBe('moved');
    expect(applied).toEqual([
      ['t1', 'In Progress', 4],
      ['t1', 'In Progress', 5],
    ]);
    expect(full.send).toHaveBeenCalledWith(expect.objectContaining({ revision: 4 }), 'In Progress');
  });

  it('Done 且有未完成子 Task：先确认；取消则不发请求也不移动', async () => {
    const { full, applied } = deps({ confirmDone: vi.fn(async () => false) });
    expect(await moveTask(subject({ openChildCount: 2 }), 'Done', full)).toBe('cancelled');
    expect(full.confirmDone).toHaveBeenCalledWith(2);
    expect(full.send).not.toHaveBeenCalled();
    expect(applied).toEqual([]);
  });

  it('Done 且有未完成子 Task：确认后才发送', async () => {
    const { full } = deps();
    expect(await moveTask(subject({ openChildCount: 1 }), 'Done', full)).toBe('moved');
    expect(full.send).toHaveBeenCalledTimes(1);
  });

  it('没有未完成子 Task 时不弹确认', async () => {
    const { full } = deps();
    await moveTask(subject(), 'Done', full);
    expect(full.confirmDone).not.toHaveBeenCalled();
  });

  it('409 冲突：回滚到原列并提示刷新', async () => {
    const { ApiError } = await import('../src/lib/api');
    const { full, applied, notices } = deps({
      send: vi.fn(async () => {
        throw new ApiError(409, 'revision_conflict', '冲突', undefined, undefined, 9);
      }),
    });
    expect(await moveTask(subject(), 'Waiting', full)).toBe('conflict');
    expect(applied.at(-1)).toEqual(['t1', 'Planned', 4]);
    expect(notices[0]).toContain('Refresh');
  });

  it('其它失败：回滚并指明更新失败', async () => {
    const { NetworkError } = await import('../src/lib/api');
    const { full, applied, notices } = deps({
      send: vi.fn(async () => {
        throw new NetworkError();
      }),
    });
    expect(await moveTask(subject(), 'Blocked', full)).toBe('failed');
    expect(applied.at(-1)).toEqual(['t1', 'Planned', 4]);
    expect(notices[0]).toContain('Update failed');
  });
});

describe('Kanban 布局', () => {
  it('列表顺序固定 Planned → Done；每张卡片只在其 Status 对应的列', () => {
    const tasks = [row('a'), row('b', { status: 'Done' }), row('c', { status: 'Blocked' }), row('d')];
    const groups = groupByStatus(tasks);
    expect(Object.keys(groups)).toEqual([...STATUSES]);
    expect(groups.Planned.map((t) => t.id)).toEqual(['a', 'd']);
    expect(groups.Done.map((t) => t.id)).toEqual(['b']);
    expect(groups['In Progress']).toEqual([]);
  });

  it('列 id 解析：列外与未知目标为 null', () => {
    expect(columnOf('col:Done')).toBeNull(); // Done is history, never a drag target
    expect(columnOf('col:Nope')).toBeNull();
    expect(columnOf('task-1')).toBeNull();
    expect(columnOf(undefined)).toBeNull();
  });
});

function mountKanban(tasks = [row('a'), row('b', { status: 'In Progress', revision: 7 })], routes: Parameters<typeof stubFetch>[0] = {}) {
  const queryKey = 'tasks:node:scope:0';
  const stub = stubFetch({
    views: { tasks: () => ({ items: tasks, total: tasks.length }) },
    actions: {
      'node-update': (body) => ({
        node: { id: body.id, revision: Number(body.baseRevision) + 1 },
      }),
      ...routes.actions,
    },
  });
  setData<TasksView>(queryKey, { items: tasks, total: tasks.length });
  const c = render(<Kanban tasks={tasks} queryKey={queryKey} today="2026-11-06" />);
  return { c, stub, queryKey };
}

const menuItem = (root: ParentNode, status: string): HTMLElement => {
  const found = Array.from(root.querySelectorAll<HTMLElement>('[role="menuitem"]')).find((el) => el.textContent?.endsWith(status));
  if (!found) throw new Error(`未找到菜单项 ${status}`);
  return found;
};

const statusOf = (queryKey: string, id: string) => getEntry<TasksView>(queryKey).data?.items.find((r) => r.id === id)?.status;

describe('Kanban 组件', () => {
  it('四个固定活动列，没有 Done 列；每张卡片有状态菜单及完成快捷按钮', () => {
    const { c } = mountKanban();
    expect(Array.from(c.querySelectorAll('[data-column]')).map((el) => el.getAttribute('data-column'))).toEqual(STATUSES.filter((s) => s !== 'Done'));
    expect(c.querySelector('[data-column="Done"]')).toBeNull();
    expect(c.querySelectorAll('.card-complete')).toHaveLength(2);
    expect(c.querySelector('[data-column="Planned"] [data-task-id="a"]')).not.toBeNull();
    expect(c.querySelector('[data-column="In Progress"] [data-task-id="b"]')).not.toBeNull();
    for (const button of Array.from(c.querySelectorAll('.card-move'))) {
      expect(button.getAttribute('aria-haspopup')).toBe('menu');
    }
  });

  it('键盘菜单路径：选择目标列后走同一个 moveTask（node-update{status}，乐观移动）', async () => {
    const { c, stub, queryKey } = mountKanban();
    click(c.querySelector('[data-task-id="a"] .card-move') as Element);
    const menu = c.querySelector('[role="menu"]') as HTMLElement;
    expect(menu).not.toBeNull();
    expect(menu.querySelectorAll('[role="menuitem"]').length).toBe(3);
    expect(menu.textContent).not.toContain('Done');
    click(menuItem(menu, 'Waiting'));
    expect(statusOf(queryKey, 'a')).toBe('Waiting'); // 乐观移动
    await flush();
    expect(stub.posts).toEqual([
      { id: 'a', baseRevision: 1, changes: { status: 'Waiting' }, action: 'node-update' },
    ]);
    expect(statusOf(queryKey, 'a')).toBe('Waiting');
  });

  it('菜单内 Esc 只关闭菜单', async () => {
    const { c } = mountKanban();
    click(c.querySelector('[data-task-id="a"] .card-move') as Element);
    expect(c.querySelector('[role="menu"]')).not.toBeNull();
    const { closeTopOverlay } = await import('../src/lib/keyboard');
    act(() => {
      closeTopOverlay();
    });
    expect(c.querySelector('[role="menu"]')).toBeNull();
    key(document.body, 'Escape');
  });

  it('409：1 秒内回滚到原列并提示刷新', async () => {
    const { c, queryKey } = mountKanban(undefined, {
      actions: { 'node-update': () => fail(409, 'revision_conflict', { currentRevision: 9 }) },
    });
    click(c.querySelector('[data-task-id="a"] .card-move') as Element);
    click(menuItem(c, 'Blocked'));
    await flush();
    expect(statusOf(queryKey, 'a')).toBe('Planned');
  });

  it('完成快捷按钮：有子任务时二次确认；取消不写库', async () => {
    const tasks = [row('a', { openChildCount: 3 })];
    const { c, stub, queryKey } = mountKanban(tasks);
    click(c.querySelector('[data-task-id="a"] .card-complete') as Element);
    const dialog = document.querySelector('dialog[open]') as HTMLElement;
    expect(dialog.textContent).toContain('3 open sub-Tasks remain');
    click(byText(dialog, 'button', 'Cancel'));
    await flush();
    expect(stub.posts).toHaveLength(0);
    expect(statusOf(queryKey, 'a')).toBe('Planned');
  });

  it('完成快捷按钮：即使没有子任务，也必须确认后才能更新 Done', async () => {
    const tasks = [row('a', { openChildCount: 0 })];
    const { c, stub, queryKey } = mountKanban(tasks);
    click(c.querySelector('[data-task-id="a"] .card-complete') as Element);
    expect(stub.posts).toHaveLength(0);
    click(byText(document.querySelector('dialog[open]') as HTMLElement, 'button', 'Confirm Done'));
    await flush();
    expect(stub.posts[0]).toMatchObject({ action: 'node-update', changes: { status: 'Done' } });
    expect(statusOf(queryKey, 'a')).toBe('Done');
  });

  it('Done history replaces the Board and groups completed items by date with L1/L2/L3', () => {
    const done = row('d1', { status: 'Done', title: 'Release gate', updatedAt: '2026-11-01T09:45:00+00:00',
      path: [{ id: 'i', title: 'Project' }, { id: 'w', title: 'Stream' }] });
    const { c } = mountKanban([row('a'), done]);
    expect(c.querySelector('[data-column="Done"]')).toBeNull();
    click(byText(c, 'button', 'Done history (1)'));
    const record = c.querySelector('.done-record[data-task-id="d1"]')!;
    expect(record).not.toBeNull();
    expect(c.querySelectorAll('.done-day')).toHaveLength(1);
    expect(record.textContent).toContain('Project');
    expect(record.textContent).toContain('Stream');
    expect(record.textContent).toContain('Release gate');
    expect(record.querySelectorAll('.done-level')).toHaveLength(3);
    expect(c.querySelector('.kanban')).toBeNull();
    click(byText(c, 'button', 'Back to Board'));
    expect(c.querySelector('[data-column="Planned"]')).not.toBeNull();
  });
});
