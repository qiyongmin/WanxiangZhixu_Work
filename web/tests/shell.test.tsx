import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { AppShell } from '../src/components/AppShell';
import { MigrationGate } from '../src/components/MigrationGate';
import { PREFIX } from '../src/lib/storage';
import { click, flush, jsonResponse, render } from './helpers';
import { sampleTree } from './fixtures';

afterEach(() => {
  vi.unstubAllGlobals();
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 });
});

function setWidth(width: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
}

function shell() {
  return render(
    <AppShell left={<p>left</p>} inspector={<p>right</p>}>
      <p>main</p>
    </AppShell>,
  );
}

const byLabel = (c: HTMLElement, label: string) => c.querySelector<HTMLButtonElement>(`.toolbar button[aria-label="${label}"]`) as HTMLButtonElement;

describe('AppShell 布局', () => {
  it('默认两侧展开，含 skip-link 与 aria-live 状态区，无顶部主导航', () => {
    setWidth(1280);
    const c = shell();
    const root = c.querySelector('.app-shell') as HTMLElement;
    expect(root.dataset.left).toBe('open');
    expect(root.dataset.right).toBe('open');
    expect(c.querySelector('a.skip-link')?.getAttribute('href')).toBe('#main');
    expect(c.querySelector('[aria-live="polite"]')).not.toBeNull();
    expect(c.querySelector('header nav')).toBeNull();
  });

  it('折叠切换 data/aria-hidden、写入 kbw:v1:layout，且中栏滚动容器不重新挂载', () => {
    setWidth(1280);
    const c = shell();
    const main = c.querySelector('main') as HTMLElement;
    const toggleLeft = byLabel(c, 'Show or hide navigation');
    click(toggleLeft);
    const root = c.querySelector('.app-shell') as HTMLElement;
    expect(root.dataset.left).toBe('closed');
    expect(c.querySelector('.pane-left')?.getAttribute('aria-hidden')).toBe('true');
    expect(c.querySelector('main')).toBe(main);
    expect(JSON.parse(window.localStorage.getItem(`${PREFIX}layout`) as string)).toEqual({
      leftOpen: false,
      inspectorOpen: true,
    });
    click(toggleLeft);
    expect(root.dataset.left).toBe('open');
    expect(c.querySelector('main')).toBe(main);
  });

  it('恢复已保存的折叠状态', () => {
    setWidth(1280);
    window.localStorage.setItem(`${PREFIX}layout`, JSON.stringify({ leftOpen: false, inspectorOpen: false }));
    const root = shell().querySelector('.app-shell') as HTMLElement;
    expect(root.dataset.left).toBe('closed');
    expect(root.dataset.right).toBe('closed');
  });

  it('无效存储回退为全部展开', () => {
    setWidth(1280);
    window.localStorage.setItem(`${PREFIX}layout`, '{"leftOpen":1}');
    const root = shell().querySelector('.app-shell') as HTMLElement;
    expect(root.dataset.left).toBe('open');
    expect(root.dataset.right).toBe('open');
  });

  it('视口 <1024px 时 Inspector 默认折叠并忽略已保存的展开状态，一次点击即可展开', () => {
    setWidth(900);
    window.localStorage.setItem(`${PREFIX}layout`, JSON.stringify({ leftOpen: true, inspectorOpen: true }));
    const c = shell();
    const root = c.querySelector('.app-shell') as HTMLElement;
    expect(root.dataset.right).toBe('closed');
    click(byLabel(c, 'Show or hide inspector'));
    expect(root.dataset.right).toBe('open');
  });
});

describe('MigrationGate', () => {
  it('显示说明、CLI 命令、备份与迁移按钮', () => {
    const c = render(<MigrationGate backup={{ ok: false, newest: null, ageHours: null, reason: 'No backup yet' }} />);
    expect(c.textContent).toContain('python3 tools/work_backup.py create');
    expect(c.textContent).toContain('python3 tools/work_migrate.py apply');
    expect(c.textContent).toContain('No backup yet');
    const labels = Array.from(c.querySelectorAll('button')).map((b) => b.textContent);
    expect(labels).toEqual(['Create backup', 'Run migration']);
  });

  it('创建备份后显示路径与 SHA256', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, { ok: true, data: { path: '/x/backup.tar.gz', sha256: 'f'.repeat(64), files: 3, bytes: 9 } }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const c = render(<MigrationGate />);
    click(c.querySelectorAll('button')[0] as Element);
    await flush();
    expect(c.textContent).toContain('/x/backup.tar.gz');
    expect(c.textContent).toContain('f'.repeat(64));
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ action: 'backup-create' });
  });

  it('迁移失败时显示失败原因', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(409, { ok: false, code: 'backup_required', error: '请先创建备份' }),
      ),
    );
    const c = render(<MigrationGate />);
    click(c.querySelectorAll('button')[1] as Element);
    await flush();
    const alert = c.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('Migration failed');
    // The Chinese backend text is never shown: the error code maps to an English message.
    expect(alert?.textContent).toContain('A recent backup is required first.');
    expect(alert?.textContent).not.toMatch(/[\u4e00-\u9fff]/);
  });
});

function routeFetch(handlers: Record<string, () => Response>) {
  return vi.fn(async (url: string) => {
    const view = new URL(url, 'http://localhost').searchParams.get('view') as string;
    const handler = handlers[view];
    return handler ? handler() : jsonResponse(404, { ok: false, code: 'unknown_endpoint', error: 'x' });
  });
}

describe('App 与 MigrationGate 集成', () => {
  it('schema.migrated=false 时全页显示升级页', async () => {
    vi.stubGlobal(
      'fetch',
      routeFetch({
        schema: () =>
          jsonResponse(200, {
            ok: true,
            data: { version: 1, migrated: false, backup: { ok: false, newest: null, ageHours: null, reason: null }, shellRoot: 'legacy' },
          }),
      }),
    );
    const c = render(<App />);
    await flush();
    expect(c.querySelector('#gate-title')?.textContent).toBe('Database upgrade needed');
    expect(c.querySelector('.app-shell')).toBeNull();
  });

  it('任意请求 409 migration_required 时显示升级页', async () => {
    vi.stubGlobal(
      'fetch',
      routeFetch({
        schema: () => jsonResponse(409, { ok: false, code: 'migration_required', error: '需要迁移' }),
      }),
    );
    const c = render(<App />);
    await flush();
    expect(c.querySelector('#gate-title')).not.toBeNull();
  });

  it('树请求 409 时同样显示升级页', async () => {
    vi.stubGlobal(
      'fetch',
      routeFetch({
        schema: () =>
          jsonResponse(200, {
            ok: true,
            data: { version: 2, migrated: true, backup: { ok: true, newest: 'x', ageHours: 1, reason: null }, shellRoot: 'shell' },
          }),
        tree: () => jsonResponse(409, { ok: false, code: 'migration_required', error: '需要迁移' }),
      }),
    );
    const c = render(<App />);
    await flush();
    expect(c.querySelector('#gate-title')).not.toBeNull();
  });

  it('已迁移：渲染三栏、左树与入口；树失败时入口仍可用并可重试', async () => {
    const migrated = () =>
      jsonResponse(200, {
        ok: true,
        data: { version: 2, migrated: true, backup: { ok: true, newest: 'x', ageHours: 1, reason: null }, shellRoot: 'shell' },
      });
    let treeOk = false;
    vi.stubGlobal(
      'fetch',
      routeFetch({
        schema: migrated,
        tree: () => (treeOk ? jsonResponse(200, { ok: true, data: sampleTree() }) : jsonResponse(500, { ok: false, code: 'internal_error', error: '内部错误' })),
      }),
    );
    const c = render(<App />);
    await flush();
    expect(c.querySelector('.error-bar')?.textContent).toContain('Could not load the navigation tree');
    const entries = Array.from(c.querySelectorAll('.entry')).map((a) => a.textContent);
    expect(entries).toEqual(['Cockpit', 'AI Resources', 'Files', 'Agent access', 'Settings']);
    expect(c.querySelector('.toolbar-brand')?.getAttribute('aria-label')).toBe('万象知序 - Work');
    expect(c.querySelector('.toolbar-brand')?.textContent).toContain('万象知序');
    expect(c.querySelector('.toolbar-brand')?.textContent).toContain('Work');
    expect(c.querySelector('.toolbar-brand-logo')).not.toBeNull();
    // Search lives in the top bar as an icon-only button, not in the left entries.
    expect(entries).not.toContain('Search');
    expect(c.querySelector('.toolbar button[aria-label="Search (Ctrl+K)"]')).not.toBeNull();
    treeOk = true;
    click(c.querySelector('.error-bar button') as Element);
    await flush();
    expect(c.querySelector('[role="tree"]')).not.toBeNull();
    click(Array.from(c.querySelectorAll('.entry')).find((a) => a.textContent === 'Settings') as Element);
    await flush(1);
    expect(c.querySelector('main')?.textContent).toContain('Yongmin Qi');
    expect(c.querySelector('main')?.textContent).not.toContain('Keyboard shortcuts');
  });
});
