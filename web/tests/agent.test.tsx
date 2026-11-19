import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentAccess } from '../src/components/agent/AgentAccess';
import { AgentActivity, groupAgentWritesByDay } from '../src/components/agent/AgentActivity';
import { Proposals } from '../src/components/agent/Proposals';
import { UnconfirmedControls } from '../src/components/agent/UnconfirmedMark';
import { ActivityTab } from '../src/components/node/ActivityTab';
import { TaskRowItem } from '../src/components/tasks/TaskRowItem';
import type { AgentWriteRow, ProposalDTO, SummaryHistoryItem } from '../src/lib/types';
import { click, flush, jsonResponse, render } from './helpers';
import { byText, dto, fail, row, setValue, stubFetch } from './p2';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function write(id: string, extra: Partial<AgentWriteRow> = {}): AgentWriteRow {
  return {
    writeId: id,
    actor: 'agent:kiro',
    nodeId: 'n1',
    nodePath: 'Alpha/父级/一个 Task',
    op: 'add_note',
    createdAt: '2026-11-01T10:00:05+00:00',
    state: 'unconfirmed',
    resolvedAt: null,
    ...extra,
  };
}

const history: SummaryHistoryItem[] = [
  { revision: 7, actor: 'user', source: 'shell:summary-set', occurredAt: '2026-11-02T00:00:00+00:00', text: '新摘要', isCurrent: true, rollbackable: false },
  { revision: 4, actor: 'agent:kiro', source: 'agent-api:update_summary', occurredAt: '2026-11-01T00:00:00+00:00', text: '旧摘要', isCurrent: false, rollbackable: true },
];

describe('Summary 历史与回滚', () => {
  const node = dto({ id: 'n1', revision: 7 });

  it('只有非当前版本显示「回滚」；确认对话框后调用 summary-rollback', async () => {
    const stub = stubFetch({
      views: { 'summary-history': () => history, activity: () => ({ items: [], nextBefore: null }) },
      actions: { 'summary-rollback': () => ({ node: dto({ id: 'n1', revision: 8 }) }) },
    });
    const c = render(<ActivityTab node={node} />);
    await flush();
    const items = c.querySelectorAll('.summary-history li');
    expect(items).toHaveLength(2);
    expect(items[0]!.querySelector('button')).toBeNull();
    expect(items[0]!.textContent).toContain('Current version');
    expect(items[1]!.textContent).toContain('agent:kiro');
    click(items[1]!.querySelector('button')!);
    expect(document.querySelector('dialog')!.textContent).toContain('Revision 4');
    click(byText(document.querySelector('dialog') as HTMLElement, 'button', 'Confirm roll back'));
    await flush();
    expect(stub.posts[0]).toMatchObject({ action: 'summary-rollback', id: 'n1', baseRevision: 7, targetRevision: 4 });
    expect(document.querySelector('dialog')).toBeNull();
  });

  it('rollback_target_invalid 与 409 显示原因，当前内容保持不变', async () => {
    let code = 'rollback_target_invalid';
    const stub = stubFetch({
      views: { 'summary-history': () => history, activity: () => ({ items: [], nextBefore: null }) },
      actions: { 'summary-rollback': () => fail(code === 'rollback_target_invalid' ? 400 : 409, code) },
    });
    const c = render(<ActivityTab node={node} />);
    await flush();
    click(c.querySelectorAll('.summary-history li')[1]!.querySelector('button')!);
    click(byText(document.querySelector('dialog') as HTMLElement, 'button', 'Confirm roll back'));
    await flush();
    expect(c.querySelector('.summary-history [role="alert"]')?.textContent).toContain('rollback target is not valid');
    code = 'revision_conflict';
    click(c.querySelectorAll('.summary-history li')[1]!.querySelector('button')!);
    click(byText(document.querySelector('dialog') as HTMLElement, 'button', 'Confirm roll back'));
    await flush();
    expect(c.querySelector('.summary-history [role="alert"]')?.textContent).toContain('Nothing was rolled back');
    expect(c.querySelectorAll('.summary-history li')).toHaveLength(2);
    expect(stub.posts).toHaveLength(2);
  });

  it('动态 Tab 列出未确认 Agent 写入（从新到旧），带标记文字与图标', async () => {
    stubFetch({ views: { 'summary-history': () => [], activity: () => ({ items: [], nextBefore: null }) } });
    const withWrites = dto({
      id: 'n1',
      unconfirmed: [
        { writeId: 'w1', op: 'add_note', ref: 'r', actor: 'agent:a', createdAt: '2026-11-01T09:00:00+00:00' },
        { writeId: 'w2', op: 'update_summary', ref: 'summary', actor: 'agent:b', createdAt: '2026-11-01T11:00:00+00:00' },
      ],
    });
    const c = render(<ActivityTab node={withWrites} />);
    await flush();
    const rows = c.querySelectorAll('.unconfirmed-list li');
    expect(Array.from(rows).map((r) => r.getAttribute('data-write-id'))).toEqual(['w2', 'w1']);
    const mark = rows[0]!.querySelector('[data-unconfirmed-mark]')!;
    expect(mark.textContent).toContain('Agent write (unconfirmed)');
    expect(mark.querySelector('[aria-hidden="true"]')).toBeTruthy();
  });
});

describe('UnconfirmedControls', () => {
  it('确认调用 agent-confirm 并刷新节点缓存', async () => {
    const stub = stubFetch({
      actions: { 'agent-confirm': () => ({ write: { writeId: 'w1', state: 'confirmed' }, node: dto({ id: 'n1', revision: 9 }) }) },
    });
    const onDone = vi.fn();
    const c = render(<UnconfirmedControls writeId="w1" subject="周报" onDone={onDone} />);
    click(c.querySelector('button[aria-label="Confirm: 周报"]')!);
    await flush();
    expect(stub.posts[0]).toEqual({ action: 'agent-confirm', writeId: 'w1' });
    expect(onDone).toHaveBeenCalledWith('confirm');
  });

  it('modified_since 被拒：状态不变，提示存在更新的修改', async () => {
    stubFetch({ actions: { 'agent-undo': () => fail(409, 'modified_since') } });
    const onDone = vi.fn();
    const c = render(<UnconfirmedControls writeId="w1" onDone={onDone} />);
    click(byText(c, 'button', 'Undo'));
    await flush();
    expect(c.querySelector('[role="alert"]')?.textContent).toContain('changed after the Agent write');
    expect(onDone).not.toHaveBeenCalled();
    expect(byText(c, 'button', 'Confirm')).toBeTruthy();
  });

  it('not_unconfirmed 被拒：提示已被处理', async () => {
    stubFetch({ actions: { 'agent-confirm': () => fail(409, 'not_unconfirmed') } });
    const c = render(<UnconfirmedControls writeId="w1" />);
    click(byText(c, 'button', 'Confirm'));
    await flush();
    expect(c.querySelector('[role="alert"]')?.textContent).toContain('already been handled');
  });
});

describe('Task 行标记', () => {
  it('unconfirmed > 0 时显示「Agent 写入·未确认」', () => {
    const c = render(
      <ul>
        <TaskRowItem task={row('t1', { unconfirmed: 1 })} today="2026-11-01" active={false} focused={false} />
        <TaskRowItem task={row('t2')} today="2026-11-01" active={false} focused={false} />
      </ul>,
    );
    const rows = c.querySelectorAll('.task-row');
    expect(rows[0]!.textContent).toContain('Agent write (unconfirmed)');
    expect(rows[1]!.textContent).not.toContain('Agent write (unconfirmed)');
  });
});

describe('AgentActivity', () => {
  it('chronological groups preserve original item order, exact record IDs and audit dates', () => {
    const rows = [
      write('w1', { createdAt: '2026-11-04T02:30:00Z' }),
      write('w2', { createdAt: '2026-11-04T01:30:00Z' }),
      write('w3', { createdAt: '2026-11-03T01:30:00Z' }),
    ];
    const grouped = groupAgentWritesByDay(rows);
    expect(grouped).toHaveLength(2);
    expect(grouped[0]!.rows.map((item) => item.writeId)).toEqual(['w1', 'w2']);
    expect(grouped[1]!.rows.map((item) => item.writeId)).toEqual(['w3']);
  });

  const page = (items: AgentWriteRow[], nextCursor: string | null = null) => ({ items, nextCursor });

  it('首批请求 limit=50；未确认行才有确认/撤销；显示 Actor、路径、操作、秒级时间、状态', async () => {
    const stub = stubFetch({
      views: {
        'agent-writes': () =>
          page([write('w1'), write('w2', { state: 'confirmed', op: 'update_summary' }), write('w3', { state: 'undone' })]),
      },
    });
    const c = render(<AgentActivity />);
    await flush();
    expect(stub.gets[0]!.params.limit).toBe('50');
    const rows = c.querySelectorAll('.agent-event');
    expect(rows).toHaveLength(3);
    expect(c.querySelectorAll('.agent-day')).toHaveLength(1);
    expect(c.querySelector('[data-summary="unconfirmed"]')?.textContent).toContain('1');
    expect(rows[0]!.textContent).toContain('agent:kiro');
    expect(rows[0]!.textContent).toContain('Alpha/父级/一个 Task');
    expect(rows[0]!.textContent).toContain('Add Note');
    expect(rows[0]!.querySelectorAll('button')).toHaveLength(2);
    expect(rows[1]!.querySelectorAll('button')).toHaveLength(0);
    expect(rows[1]!.textContent).toContain('Confirmed');
    expect(rows[2]!.textContent).toContain('Undone');
    expect(rows[0]!.querySelector('time')!.getAttribute('datetime')).toBe('2026-11-01T10:00:05+00:00');
  });

  it('滚动/按钮加载下一批：带 cursor，追加后保持顺序', async () => {
    const stub = stubFetch({
      views: {
        'agent-writes': (params) =>
          params.cursor ? page([write('w3', { createdAt: '2026-10-31T10:00:00+00:00' })]) : page([write('w1'), write('w2')], 'c|w2'),
      },
    });
    const c = render(<AgentActivity />);
    await flush();
    click(byText(c, 'button', 'Load more'));
    await flush();
    expect(stub.gets.at(-1)!.params.cursor).toBe('c|w2');
    expect(Array.from(c.querySelectorAll('.agent-event')).map((r) => r.getAttribute('data-write-id'))).toEqual(['w1', 'w2', 'w3']);
    expect(Array.from(c.querySelectorAll('button')).some((b) => b.textContent === 'Load more')).toBe(false);
  });

  it('过滤条件（Actor、状态、起止日期）变化后重新请求，并保持返回顺序', async () => {
    const stub = stubFetch({ views: { 'agent-writes': () => page([write('w1')]) } });
    const c = render(<AgentActivity />);
    await flush();
    setValue(c.querySelector<HTMLSelectElement>('select')!, 'unconfirmed');
    await flush();
    const dates = c.querySelectorAll<HTMLInputElement>('input[type="date"]');
    setValue(dates[0]!, '2026-11-01');
    setValue(dates[1]!, '2026-11-30');
    await flush();
    setValue(c.querySelector<HTMLInputElement>('input[type="text"]')!, 'agent:kiro');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
    });
    await flush();
    const last = stub.gets.at(-1)!.params;
    expect(last).toMatchObject({ state: 'unconfirmed', from: '2026-11-01', to: '2026-11-30', actor: 'agent:kiro' });
  });

  it('无匹配：显示「无匹配记录」；清除过滤条件后恢复', async () => {
    let empty = true;
    stubFetch({ views: { 'agent-writes': (params) => (params.state && empty ? page([]) : page([write('w1')])) } });
    const c = render(<AgentActivity />);
    await flush();
    setValue(c.querySelector<HTMLSelectElement>('select')!, 'undone');
    await flush();
    expect(c.textContent).toContain('No matching records');
    click(byText(c, 'button', 'Clear filters'));
    await flush();
    expect(c.querySelectorAll('.agent-event')).toHaveLength(1);
    expect(c.querySelector<HTMLSelectElement>('select')!.value).toBe('');
    empty = false;
  });

  it('加载下一批失败：保留已显示数据，显示错误与重试', async () => {
    let fails = true;
    stubFetch({
      views: {
        'agent-writes': (params) => {
          if (params.cursor) return fails ? jsonResponse(500, { ok: false, code: 'internal_error', error: '内部错误' }) : page([write('w9')]);
          return page([write('w1')], 'c|w1');
        },
      },
    });
    const c = render(<AgentActivity />);
    await flush();
    click(byText(c, 'button', 'Load more'));
    await flush();
    expect(c.querySelector('[role="alert"]')?.textContent).toContain('Unexpected server error.');
    expect(c.querySelectorAll('.agent-event')).toHaveLength(1);
    fails = false;
    click(byText(c.querySelector('[role="alert"]') as HTMLElement, 'button', 'Retry'));
    await flush();
    expect(c.querySelectorAll('.agent-event')).toHaveLength(2);
    expect(c.querySelector('[role="alert"]')).toBeNull();
  });

  it('行内确认被拒：状态不变并在该行显示原因', async () => {
    stubFetch({
      views: { 'agent-writes': () => page([write('w1')]) },
      actions: { 'agent-undo': () => fail(409, 'modified_since') },
    });
    const c = render(<AgentActivity />);
    await flush();
    click(byText(c.querySelector('.agent-event') as HTMLElement, 'button', 'Undo'));
    await flush();
    const first = c.querySelector('.agent-event') as HTMLElement;
    expect(first.getAttribute('data-state')).toBe('unconfirmed');
    expect(first.querySelector('[role="alert"]')?.textContent).toContain('changed after the Agent write');
  });
});

describe('Proposals', () => {
  const proposal = (extra: Partial<ProposalDTO> = {}): ProposalDTO => ({
    id: 'proposal-1',
    nodeId: 'n1',
    status: 'pending',
    proposer: 'agent:kiro',
    rationale: '依赖未就绪',
    evidence: ['证据一', '证据二'],
    baseRevision: 3,
    createdAt: '2026-11-01T10:00:00+00:00',
    before: { status: 'Planned' },
    after: { status: 'Blocked' },
    nodePath: 'Alpha/父级/一个 Task',
    ...extra,
  });

  it('无数据显示「无待审批提案」', async () => {
    stubFetch({ views: { 'change-proposals': () => [] } });
    const c = render(<Proposals />);
    await flush();
    expect(c.textContent).toContain('No pending proposals');
  });

  it('展示前后对比、理由与证据；批准后调用 proposal-approve', async () => {
    const stub = stubFetch({
      views: { 'change-proposals': () => [proposal()] },
      actions: { 'proposal-approve': () => ({ proposal: {}, node: dto() }) },
    });
    const c = render(<Proposals />);
    await flush();
    expect(c.querySelector('.diff-before')!.textContent).toBe('Planned');
    expect(c.querySelector('.diff-after')!.textContent).toBe('Blocked');
    expect(c.textContent).toContain('依赖未就绪');
    expect(c.textContent).toContain('证据二');
    click(byText(c, 'button', 'Approve'));
    await flush();
    expect(stub.posts[0]).toEqual({ action: 'proposal-approve', id: 'proposal-1' });
  });

  it('409 proposal_expired / proposal_closed 与批准阶段违规各有明确提示', async () => {
    let next: Response = fail(409, 'proposal_expired');
    stubFetch({
      views: { 'change-proposals': () => [proposal()] },
      actions: { 'proposal-approve': () => next },
    });
    const c = render(<Proposals />);
    await flush();
    click(byText(c, 'button', 'Approve'));
    await flush();
    expect(c.textContent).toContain('proposal expired');
    next = fail(409, 'proposal_closed');
    click(byText(c, 'button', 'Approve'));
    await flush();
    expect(c.textContent).toContain('already been handled');
    next = fail(400, 'section_rule_violation', { error: '违反 Section 规则', details: { fields: [{ field: 'status', reason: '该 Section 不允许 Blocked' }] } });
    click(byText(c, 'button', 'Approve'));
    await flush();
    expect(c.textContent).toContain('Rule violated');
    // The Chinese backend wording is replaced by the English message of the error code.
    expect(c.textContent).toContain('This change violates the Section rule.');
    expect(c.textContent).not.toContain('该 Section 不允许 Blocked');
  });
});

describe('AgentAccess', () => {
  it('Agent Access separates Connections/API from the new Activities section', async () => {
    stubFetch({
      views: {
        'agent-writes': (params) => ({ items: params.limit === '20' ? [write('w1')] : [], nextCursor: null }),
      },
    });
    const c = render(<AgentAccess />);
    await flush();
    expect(c.textContent).toContain('/api/work-hub/agent/note');
    expect(c.textContent).toContain('upload-report');
    expect(c.querySelector('.skill-list')).toBeNull();
    expect(c.textContent).toContain('Open Skills Library');
    expect(c.querySelector('a[href="/app/resources/skills"]')).not.toBeNull();
    expect(c.querySelector('.recent-writes')).toBeNull();
    expect(c.querySelector('a[href="/app/agent/access?tab=activities"]')).not.toBeNull();
    expect(c.querySelector('.agent-access-tabs')).not.toBeNull();
  });

  it('Connections view does not load Project Skills or Agent event logs', async () => {
    const stub = stubFetch({
      views: { 'agent-writes': () => fail(503, 'unavailable') },
    });
    const c = render(<AgentAccess />);
    await flush();
    expect(c.querySelector('.agent-access-resource-link')).not.toBeNull();
    expect(c.querySelector('.skill-list')).toBeNull();
    expect(c.querySelector('.recent-writes')).toBeNull();
    expect(c.textContent).toContain('Connections & API');
    expect(c.textContent).toContain('Agent Activities');
    expect(stub.mock).toHaveBeenCalled();
    expect(stub.mock.mock.calls.some(([url]) => String(url).includes('project-skills.json'))).toBe(false);
    expect(stub.mock.mock.calls.some(([url]) => String(url).includes('view=agent-writes'))).toBe(false);
  });
});
