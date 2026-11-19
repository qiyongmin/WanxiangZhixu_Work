// Phase 2 测试辅助：TaskRow / NodeDTO 工厂与按 view / action 路由的 fetch 桩。
import { act } from 'react';
import { vi } from 'vitest';
import type { NodeDTO, TaskRow } from '../src/lib/types';
import { jsonResponse } from './helpers';

export function row(id: string, extra: Partial<TaskRow> = {}): TaskRow {
  return {
    id,
    kind: 'task',
    title: `Task ${id}`,
    status: 'Planned',
    priority: 'Medium',
    dueDate: null,
    remindAt: null,
    remindPending: false,
    repeat: null,
    tags: [],
    parentId: 'p1',
    path: [{ id: 'p1', title: '父级' }],
    sectionId: 'sec',
    revision: 1,
    openChildCount: 0,
    unconfirmed: 0,
    updatedAt: '2026-11-01T00:00:00+00:00',
    ...extra,
  };
}

export function dto(extra: Partial<NodeDTO> = {}): NodeDTO {
  return {
    id: 'n1',
    kind: 'task',
    displayKind: 'Task',
    parentId: 'p1',
    title: '一个 Task',
    status: 'Planned',
    revision: 3,
    createdAt: '2026-01-01T00:00:00',
    updatedAt: '2026-01-02T00:00:00',
    archivedAt: null,
    deletedAt: null,
    depth: 2,
    overDepth: false,
    sectionId: 'sec',
    path: [{ id: 'p1', title: '父级' }],
    nodePath: 'Alpha/父级/一个 Task',
    description: '',
    priority: 'Medium',
    dueDate: null,
    remindAt: null,
    remindPending: false,
    repeat: null,
    tags: [],
    summary: { text: '', html: '' },
    stats: { open: 0, byStatus: { Planned: 0, 'In Progress': 0, Waiting: 0, Blocked: 0 } },
    childCount: 0,
    unconfirmed: [],
    links: [],
    backRefs: [],
    ...extra,
  };
}

type ViewHandler = (params: Record<string, string>) => unknown;
type ActionHandler = (body: Record<string, unknown>) => unknown;

export interface Routes {
  views?: Record<string, ViewHandler>;
  actions?: Record<string, ActionHandler>;
}

export interface Stub {
  mock: ReturnType<typeof vi.fn>;
  /** 每次 GET：`{view, params}`。 */
  gets: Array<{ view: string; params: Record<string, string> }>;
  /** 每次 POST 的请求体。 */
  posts: Array<Record<string, unknown>>;
}

export function ok(data: unknown): Response {
  return jsonResponse(200, { ok: true, data });
}

export function fail(status: number, code: string, extra: Record<string, unknown> = {}): Response {
  return jsonResponse(status, { ok: false, code, error: code, ...extra });
}

/** 未注册的 view 返回 404；handler 返回 Response 则原样使用，否则包装为 {ok:true,data}。 */
export function stubFetch(routes: Routes): Stub {
  const gets: Stub['gets'] = [];
  const posts: Stub['posts'] = [];
  const mock = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      posts.push(body);
      const handler = routes.actions?.[String(body.action)];
      if (!handler) return fail(404, 'unknown_action');
      const result = handler(body);
      return result instanceof Response ? result : ok(result);
    }
    const params = Object.fromEntries(new URL(url, 'http://localhost').searchParams.entries());
    const view = params.view ?? '';
    gets.push({ view, params });
    const handler = routes.views?.[view];
    if (!handler) return fail(404, 'unknown_view');
    const result = handler(params);
    return result instanceof Response ? result : ok(result);
  });
  vi.stubGlobal('fetch', mock);
  return { mock, gets, posts };
}

export function treeView(): unknown {
  return {
    generatedAt: 'x',
    sections: [
      { id: 'sec', title: 'Alpha', sortOrder: 0, itemKind: null, rules: {}, nodeCount: 3, open: 2, remind: false, unconfirmed: 0 },
    ],
    nodes: [
      { id: 'p1', parentId: null, kind: 'initiative', displayKind: 'Initiative', title: '父级', status: 'Planned', revision: 1, updatedAt: 'x', depth: 1, sectionId: 'sec', open: 2, remind: false, unconfirmed: 0 },
      { id: 'p2', parentId: 'p1', kind: 'workstream', displayKind: 'Workstream', title: '子级', status: 'Planned', revision: 1, updatedAt: 'x', depth: 2, sectionId: 'sec', open: 0, remind: false, unconfirmed: 0 },
      { id: 'p3', parentId: 'p2', kind: 'campaign', displayKind: 'Campaign', title: '孙级', status: 'Planned', revision: 1, updatedAt: 'x', depth: 3, sectionId: 'sec', open: 0, remind: false, unconfirmed: 0 },
      { id: 'p4', parentId: 'p3', kind: 'task', displayKind: 'Task', title: '深层', status: 'Planned', revision: 1, updatedAt: 'x', depth: 4, sectionId: 'sec', open: 0, remind: false, unconfirmed: 0 },
    ],
  };
}

export function setValue(element: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, value: string): void {
  const proto =
    element instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  act(() => {
    setter?.call(element, value);
    element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  });
}

export function byText(root: ParentNode, selector: string, text: string): HTMLElement {
  const found = Array.from(root.querySelectorAll<HTMLElement>(selector)).find((el) => el.textContent?.trim() === text);
  if (!found) throw new Error(`未找到 ${selector} "${text}"`);
  return found;
}
