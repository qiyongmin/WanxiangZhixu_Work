import { afterEach, describe, expect, it, vi } from 'vitest';
import { TasksTab } from '../src/components/tasks/TasksTab';
import { localToday } from '../src/lib/dates';
import { invalidate, resetCache } from '../src/lib/queryCache';
import { KEYS, readJson, validateTasksView, writeJson } from '../src/lib/storage';
import { click, flush, render } from './helpers';
import { byText, dto, fail, row, setValue, stubFetch } from './p2';

afterEach(() => {
  vi.unstubAllGlobals();
});

const node = dto({ id: 'scope', kind: 'initiative', displayKind: 'Initiative', parentId: null });
const yesterday = (() => {
  const date = new Date();
  date.setDate(date.getDate() - 1);
  return localToday(date);
})();

function items() {
  return [
    row('a', { title: '逾期的', dueDate: yesterday, tags: ['x', 'y'], priority: 'High', path: [{ id: '1', title: 'SAMPLE-PROJECT' }, { id: '2', title: 'REVIEW' }] }),
    row('b', { title: '没日期', dueDate: null, status: 'In Progress', tags: ['x'], priority: 'Low' }),
    row('c', { title: '已完成', dueDate: yesterday, status: 'Done', priority: 'High' }),
  ];
}

function mount(routes: Parameters<typeof stubFetch>[0] = {}) {
  const stub = stubFetch({ views: { tasks: () => ({ items: items(), total: 3 }), ...routes.views } });
  const c = render(<TasksTab node={node} />);
  return { c, stub };
}

const titles = (c: HTMLElement) => Array.from(c.querySelectorAll('.task-row .task-title')).map((el) => el.textContent);

describe('TasksTab 列表', () => {
  it('行内显示 Status、Priority、Due_Date、完整上级路径与全部 Tag；空日期显示 —', async () => {
    const { c } = mount();
    await flush();
    const first = c.querySelector('[data-task-id="a"]') as HTMLElement;
    expect(first.textContent).toContain('Planned');
    expect(first.textContent).toContain('High');
    expect(first.querySelector('.task-path')?.textContent).toBe('SAMPLE-PROJECT › REVIEW');
    expect(Array.from(first.querySelectorAll('.tag-chip')).map((el) => el.textContent)).toEqual(['x', 'y']);
    expect((c.querySelector('[data-task-id="b"] .task-due') as HTMLElement).textContent).toBe('—');
  });

  it('逾期（未 Done 且早于今天）显示「Overdue N days」文字徽标，Done 不显示', async () => {
    const { c } = mount();
    await flush();
    expect(c.querySelector('[data-task-id="a"] .flag-overdue')?.textContent).toContain('Overdue 1 day');
    expect(c.querySelector('[data-task-id="b"] .flag-overdue')).toBeNull();
    expect(c.querySelector('[data-task-id="c"] .flag-overdue')).toBeNull();
  });

  it('按 Due_Date 升序、无日期在后', async () => {
    const { c } = mount();
    await flush();
    expect(titles(c)).toEqual(['逾期的', '已完成', '没日期']);
  });

  it('Status 过滤取并集，不同维度取交集', async () => {
    const { c } = mount();
    await flush();
    const check = (group: string, label: string) => {
      const wrapper = c.querySelector(`[data-filter-key="${group}"]`)!;
      if (!wrapper.querySelector('label')) click(wrapper.querySelector('[data-filter-trigger]')!);
      const input = Array.from(wrapper.querySelectorAll('label'))
        .find((el) => el.textContent === label)
        ?.querySelector('input') as HTMLInputElement;
      click(input);
    };
    check('status', 'Planned');
    check('status', 'Done');
    expect(titles(c)).toEqual(['逾期的', '已完成']);
    check('priority', 'High');
    // 两个 High 都命中：Planned/Done ∩ High
    expect(titles(c)).toEqual(['逾期的', '已完成']);
    check('status', 'Done'); // 取消 Done → Planned ∩ High
    expect(titles(c)).toEqual(['逾期的']);
  });

  it('两种空态：范围内没有 Task / 过滤无匹配（可清除过滤条件）', async () => {
    const empty = mount({ views: { tasks: () => ({ items: [], total: 0 }) } });
    await flush();
    expect(empty.c.textContent).toContain('No Tasks here yet');
    expect(empty.c.textContent).not.toContain('Clear filters');
  });

  it('过滤无匹配时显示提示与「清除过滤条件」', async () => {
    const { c } = mount();
    await flush();
    click(c.querySelector('[data-filter-trigger="status"]')!);
    const blocked = Array.from(c.querySelectorAll('[data-filter-key="status"] label'))
      .find((el) => el.textContent === 'Blocked')
      ?.querySelector('input') as HTMLInputElement;
    click(blocked);
    expect(c.textContent).toContain('No Tasks match the filters');
    click(byText(c, '.tasks-browser button', 'Clear filters'));
    expect(titles(c)).toHaveLength(3);
  });

  it('标题关键字过滤（/ 的目标输入）', async () => {
    const { c } = mount();
    await flush();
    const input = c.querySelector('[data-search-input]') as HTMLInputElement;
    expect(input).not.toBeNull();
    setValue(input, '没日');
    expect(titles(c)).toEqual(['没日期']);
  });

  it('加载失败：错误条 + 重试，已显示内容与过滤条件保留', async () => {
    let fails = false;
    const { c } = mount({
      views: { tasks: () => (fails ? fail(500, 'internal_error') : { items: items(), total: 3 }) },
    });
    await flush();
    click(c.querySelector('[data-filter-trigger="status"]')!);
    const planned = Array.from(c.querySelectorAll('[data-filter-key="status"] label'))
      .find((el) => el.textContent === 'Planned')
      ?.querySelector('input') as HTMLInputElement;
    click(planned);
    expect(titles(c)).toEqual(['逾期的']);
    fails = true;
    invalidate('tasks:'); // 用已注册的 fetcher 重取，这次失败
    await flush();
    expect(c.querySelector('.error-bar[role="alert"]')).not.toBeNull();
    expect(titles(c)).toEqual(['逾期的']);
    expect((planned as HTMLInputElement).checked).toBe(true);
    fails = false;
    click(byText(c, '.error-bar button', 'Retry'));
    await flush();
    expect(c.querySelector('.error-bar')).toBeNull();
    expect(titles(c)).toEqual(['逾期的']);
  });
});

describe('视图与「仅直属」持久化', () => {
  it('切换后写入 kbw:v1:tasks-view，并在重新挂载时恢复', async () => {
    const { c } = mount();
    await flush();
    click(byText(c, 'button', 'Board'));
    await flush();
    const direct = c.querySelector('.tasks-toolbar input[type="checkbox"]') as HTMLInputElement;
    click(direct);
    await flush();
    expect(readJson(KEYS.tasksView, validateTasksView, { view: 'list', directOnly: false })).toEqual({
      view: 'kanban',
      directOnly: true,
    });
  });

  it('无效存储值回退为「列表 + 仅直属关闭」', async () => {
    for (const bad of [{ view: 'grid', directOnly: true }, { view: 'list' }, 'x', 3]) {
      resetCache();
      window.localStorage.setItem('kbw:v1:tasks-view', JSON.stringify(bad));
      const stub = stubFetch({ views: { tasks: () => ({ items: items(), total: 3 }) } });
      const c = render(<TasksTab node={node} />);
      await flush();
      expect(c.querySelector('.task-list')).not.toBeNull();
      expect((c.querySelector('.tasks-toolbar input[type="checkbox"]') as HTMLInputElement).checked).toBe(false);
      expect(stub.gets[0]?.params.direct).toBe('0');
    }
  });

  it('损坏的 JSON 也回退，且不抛出', async () => {
    window.localStorage.setItem('kbw:v1:tasks-view', '{oops');
    stubFetch({ views: { tasks: () => ({ items: [], total: 0 }) } });
    const c = render(<TasksTab node={node} />);
    await flush();
    expect(c.querySelector('.segmented .is-active')?.textContent).toBe('List');
    writeJson(KEYS.tasksView, { view: 'list', directOnly: false });
  });

  it('「仅直属」开启后用 direct=1 重新请求', async () => {
    window.localStorage.setItem('kbw:v1:tasks-view', JSON.stringify({ view: 'list', directOnly: true }));
    const stub = stubFetch({ views: { tasks: () => ({ items: [], total: 0 }) } });
    render(<TasksTab node={node} />);
    await flush();
    expect(stub.gets[0]?.params).toMatchObject({ scope: 'node', id: 'scope', direct: '1' });
  });
});
