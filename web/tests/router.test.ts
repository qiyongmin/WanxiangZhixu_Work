import { describe, expect, it, vi } from 'vitest';
import {
  canonicalPath,
  ensureCanonical,
  navigate,
  nodePath,
  parseRoute,
  shouldIntercept,
  stripBase,
  withBase,
} from '../src/lib/router';

describe('router 解析', () => {
  it('去除/添加 /app 前缀', () => {
    expect(stripBase('/app/')).toBe('/');
    expect(stripBase('/app')).toBe('/');
    expect(stripBase('/app/n/x/tasks')).toBe('/n/x/tasks');
    expect(withBase('/search')).toBe('/app/search');
  });

  it('解析入口与节点路由', () => {
    expect(parseRoute('/').name).toBe('cockpit');
    expect(parseRoute('/search').name).toBe('search');
    expect(parseRoute('/agent/access').name).toBe('agent-access');
    expect(parseRoute('/resources')).toMatchObject({ name: 'resources', tab: 'skills' });
    expect(parseRoute('/resources/skills')).toMatchObject({ name:'resources',tab:'skills' });
    expect(parseRoute('/resources/mcp')).toMatchObject({ name:'resources',tab:'mcp' });
    expect(parseRoute('/resources/agents')).toMatchObject({ name:'resources',tab:'agents' });
    expect(parseRoute('/resources/mcp/'+'a'.repeat(32))).toMatchObject({name:'resources',tab:'mcp',id:'a'.repeat(32)});
    expect(parseRoute('/resources/studio')).toMatchObject({ name: 'resources', tab: 'studio' });
    expect(parseRoute('/resources/reviews')).toMatchObject({ name: 'resources', tab: 'skills' });
    expect(parseRoute('/resources/' + 'a'.repeat(32))).toMatchObject({ name: 'resources', tab: 'skills', id: 'a'.repeat(32) });
    expect(parseRoute('/nope').name).toBe('not-found');
    expect(parseRoute('/n/abc/notes')).toMatchObject({ name: 'node', id: 'abc', tab: 'notes' });
  });

  it('缺省或非法 Tab 规范化为 overview', () => {
    expect(canonicalPath('/n/abc')).toBe('/n/abc/overview');
    expect(canonicalPath('/n/abc/bogus')).toBe('/n/abc/overview');
    expect(canonicalPath('/n/abc/activity')).toBe('/n/abc/activity');
    expect(canonicalPath('/settings')).toBe('/settings');
    expect(canonicalPath('/resources/reviews')).toBe('/resources/skills?status=pending');
    expect(canonicalPath('/agent')).toBe('/agent/access?tab=activities');
    expect(canonicalPath('/resources/activity')).toBe('/agent/access?tab=activities');
  });

  it('focus 仅在任务 Tab 中保留', () => {
    expect(nodePath('a', 'tasks', 't1')).toBe('/n/a/tasks?focus=t1');
    expect(nodePath('a', 'notes', 't1')).toBe('/n/a/notes');
    expect(parseRoute('/n/a/tasks?focus=t1')).toMatchObject({ focus: 't1' });
    expect(parseRoute('/n/a/notes?focus=t1')).toMatchObject({ focus: null });
  });
});

describe('router 浏览器绑定', () => {
  it('切换 Tab 使用 pushState 并立即写入地址栏', () => {
    const push = vi.spyOn(window.history, 'pushState');
    navigate('/n/abc/overview');
    navigate('/n/abc/notes');
    expect(push).toHaveBeenCalledTimes(2);
    expect(window.location.pathname).toBe('/app/n/abc/notes');
    push.mockRestore();
  });

  it('非法 Tab 使用 replaceState 更正，不新增历史', () => {
    window.history.replaceState(null, '', '/app/n/abc/bogus');
    const length = window.history.length;
    const push = vi.spyOn(window.history, 'pushState');
    expect(ensureCanonical()).toBe(true);
    expect(window.location.pathname).toBe('/app/n/abc/overview');
    expect(push).not.toHaveBeenCalled();
    expect(window.history.length).toBe(length);
    expect(ensureCanonical()).toBe(false);
    push.mockRestore();
  });

  it('popstate 触发订阅者并恢复路径', async () => {
    const seen: string[] = [];
    const listener = () => seen.push(window.location.pathname);
    window.addEventListener('popstate', listener);
    navigate('/n/abc/overview');
    navigate('/n/abc/tasks');
    const done = new Promise<void>((resolve) => window.addEventListener('popstate', () => resolve(), { once: true }));
    window.history.back();
    await done;
    expect(seen.at(-1)).toBe('/app/n/abc/overview');
    window.removeEventListener('popstate', listener);
  });

  it('Ctrl/中键等保留浏览器默认行为', () => {
    const base = { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, defaultPrevented: false };
    expect(shouldIntercept(base)).toBe(true);
    expect(shouldIntercept({ ...base, ctrlKey: true })).toBe(false);
    expect(shouldIntercept({ ...base, button: 1 })).toBe(false);
    expect(shouldIntercept(base, '_blank')).toBe(false);
  });
});
