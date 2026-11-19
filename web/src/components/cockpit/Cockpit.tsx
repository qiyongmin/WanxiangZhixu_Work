import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError, get } from '../../lib/api';
import { localNow, localToday } from '../../lib/dates';
import { describeError } from '../../lib/errors';
import { englishOr } from '../../lib/errorMessages';
import { useListNav } from '../../lib/keyboard';
import { L, L2 } from '../../lib/labels';
import { showNotice } from '../../lib/notice';
import { COCKPIT_VIEWS, KEYS, readJson, validateCockpitView, writeJson, type CockpitViewId } from '../../lib/storage';
import { invalidate, useQuery, type QueryResult } from '../../lib/queryCache';
import { isMissed } from '../../lib/reminders';
import { navigate, nodePath, shouldIntercept, useAppPath, withBase } from '../../lib/router';
import { type CockpitGroupData, type CockpitGroupId, type CockpitView, type NodeDTO, type TaskRow } from '../../lib/types';
import { buildClarityData, clarityFilter, clarityScopes, CLARITY_LANES, ClarityLane } from './CockpitClarity';
import { openQuickAdd } from '../../lib/ui';
import { UnconfirmedFeed } from '../agent/UnconfirmedFeed';
import { Icon, type IconName } from '../icons';
import { ReminderActions } from '../ReminderActions';
import { StatusBadge } from '../StatusBadge';
import { pathText } from '../tasks/TaskRowItem';

const GROUP_TITLES: Record<CockpitGroupId, string> = {
  overdue: L2.groupOverdue,
  today: L2.groupToday,
  week: L2.groupWeek,
  reminders: L2.groupReminders,
  followUp: L2.groupFollowUp,
  recent: L2.groupRecent,
};

export const cockpitKey = (group: CockpitGroupId): string => `cockpit:${group}`;

function useGroup(group: CockpitGroupId): QueryResult<CockpitGroupData> {
  // 路由进入时强制重取（staleMs: 0）；数据变更后由失效矩阵在 1 秒内刷新。
  return useQuery<CockpitGroupData>(
    cockpitKey(group),
    async (signal) => {
      const view = await get<CockpitView>('cockpit', { group, today: localToday(), now: localNow() }, { signal });
      const data = view[group];
      if (!data) throw new ApiError(500, 'bad_response', L2.groupFailed);
      return data;
    },
    { staleMs: 0 },
  );
}

interface ItemProps {
  group: CockpitGroupId;
  row: TaskRow;
  active: boolean;
  onOpen: (row: TaskRow) => void;
  onSelect: (navId: string) => void;
}

function CockpitItem({ group, row, active, onOpen, onSelect }: ItemProps) {
  const navId = `${group}:${row.id}`;
  const missed = group === 'reminders' && isMissed(row);
  return (
    <li
      className={active ? 'cockpit-item is-active' : 'cockpit-item'}
      data-nav-id={navId}
      data-task-id={row.id}
      data-active={active ? 'true' : undefined}
      aria-current={active ? 'true' : undefined}
      onClick={() => onSelect(navId)}
    >
      <div className="task-main">
        <a
          className="task-title"
          href={withBase(nodePath(row.id))}
          onClick={(event) => {
            if (shouldIntercept(event)) {
              event.preventDefault();
              onOpen(row);
            }
          }}
        >
          {row.title}
        </a>
        <StatusBadge status={row.status} />
        {missed ? (
          <span className="flag flag-missed">
            <Icon name="bell" size={12} /> {L2.reminderMissed}
          </span>
        ) : null}
        {row.unconfirmed > 0 ? <span className="flag">{L2.newMark}</span> : null}
      </div>
      <div className="task-meta">
        <span>
          {L2.due}: {row.dueDate ?? L2.noDue}
        </span>
        {group === 'reminders' && row.remindAt ? (
          <span>
            {L2.fieldRemind}: {row.remindAt.replace('T', ' ')}
          </span>
        ) : null}
        {row.path.length > 0 ? <span className="task-path">{pathText(row)}</span> : null}
      </div>
      {group === 'reminders' && row.remindAt ? (
        <ReminderActions taskId={row.id} remindAt={row.remindAt} revision={row.revision} />
      ) : null}
    </li>
  );
}


interface GroupProps {
  group: CockpitGroupId;
  query: QueryResult<CockpitGroupData>;
  gone: ReadonlySet<string>;
  activeId: string | null;
  onOpen: (row: TaskRow) => void;
  onSelect: (navId: string) => void;
}

/** Collapsed by default: real updatedAt values, newest first, grouped by day.
 * Dates are the last update timestamp, never falsely described as completion. */
export function RecentTimeline({ query, gone, activeId, onOpen, onSelect }: Omit<GroupProps, 'group'>) {
  const data = query.data;
  const rows = data && data.ok ? [...data.items.filter((row) => !gone.has(row.id))]
    .sort((a,b) => (b.lastActivityAt ?? b.updatedAt ?? '').localeCompare(a.lastActivityAt ?? a.updatedAt ?? '') || a.title.localeCompare(b.title)) : [];
  const dates = [...new Set(rows.map((row) => (row.lastActivityAt ?? row.updatedAt)?.slice(0,10) || 'Unknown date'))];
  const failure = data && !data.ok ? englishOr(data.error,L2.groupFailed) :
    query.status === 'error' ? describeError(query.error) : null;
  return <details className="cockpit-recent-disclosure" data-group="recent">
    <summary><Icon name="activity" size={17}/>
      <strong>{L2.groupRecent}</strong>
      {data && data.ok ? <span className="count-badge">{data.total}</span> : null}
      <span className="muted">Newest updates first</span>
    </summary>
    <div className="cockpit-timeline" aria-label="Recently updated timeline">
      {failure ? <div role="alert" className="error-bar">{failure}
        <button type="button" className="btn" onClick={() => void query.refetch()}>{L.retry}</button></div> : null}
      {!data && !failure ? <p className="muted" role="status">{L.loading}</p> : null}
      {data?.ok && !rows.length ? <p className="muted">{L2.groupEmpty}</p> : null}
      {dates.map((date) => <section key={date} className="cockpit-timeline-day" data-update-date={date}>
        <h3>{date}</h3>
        <ol className="cockpit-timeline-items">
          {rows.filter((row) => ((row.lastActivityAt ?? row.updatedAt)?.slice(0,10) || 'Unknown date') === date)
            .map((row) => <CockpitItem key={row.id} group="recent" row={row}
              active={activeId === `recent:${row.id}`} onOpen={onOpen} onSelect={onSelect}/>)}
        </ol>
      </section>)}
      {data?.ok && data.total > rows.length ? <p className="muted">Showing the latest {rows.length} of {data.total} items.</p> : null}
    </div>
  </details>;
}

const KPI_GROUPS: readonly CockpitGroupId[] = ['overdue', 'today', 'week', 'followUp'];

/** KPI 条：取自各分组已有的 total，不额外请求；加载完成前显示「—」。 */
function KpiStrip({ queries }: { queries: Record<CockpitGroupId, QueryResult<CockpitGroupData>> }) {
  const icons: Record<string,IconName>={overdue:'bell',today:'activity',week:'week',followUp:'subtasks'};
  const targets: Record<string,string>={overdue:'attention',today:'upcoming',week:'upcoming',followUp:'follow'};
  const hints: Record<string,string>={overdue:'Act now',today:'Due today',week:'Upcoming tasks',followUp:'Blocked and waiting'};
  return (
    <div className="kpi-strip" role="group" aria-label={L2.kpiStripLabel}>
      {KPI_GROUPS.map((group) => {
        const data = queries[group].data;
        return (
          <button type="button" key={group} className="kpi-cell clarity-kpi" data-kpi={group}
            aria-label={`${GROUP_TITLES[group]}: ${data?.ok?data.total:'unavailable'}. Go to ${targets[group]}`}
            onClick={()=>document.getElementById(`clarity-${targets[group]}`)?.scrollIntoView({behavior:'smooth',block:'start'})}>
            <span className="clarity-kpi-head">
              <span className="kpi-label">{GROUP_TITLES[group]}</span>
              <span className="clarity-kpi-icon"><Icon name={icons[group]??'overview'} size={17}/></span>
            </span>
            <span className="kpi-value">{data?.ok ? data.total : '—'}</span>
            <span className="clarity-kpi-hint">{hints[group]}</span>
          </button>
        );
      })}
    </div>
  );
}

/** Overview: six independent groups (each with its own useQuery, so one failing group does not affect the others). */
export function CockpitOverview() {
  const overdue = useGroup('overdue');
  const today = useGroup('today');
  const week = useGroup('week');
  const reminders = useGroup('reminders');
  const followUp = useGroup('followUp');
  const recent = useGroup('recent');
  const queries: Record<CockpitGroupId, QueryResult<CockpitGroupData>> = {
    overdue,
    today,
    week,
    reminders,
    followUp,
    recent,
  };
  const [gone, setGone] = useState<ReadonlySet<string>>(new Set());
  const [scope,setScope] = useState('all');
  const [search,setSearch] = useState('');
  const clarity = useMemo(()=>buildClarityData(queries,gone),
    // query responses are already memoized by useQuery; remounting a full list must not reset filters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [overdue.data,today.data,week.data,reminders.data,followUp.data,gone]);
  const scopes = useMemo(()=>clarityScopes(clarity),[clarity]);
  const filtered = useMemo(()=>clarityFilter(clarity,scope,search),[clarity,scope,search]);
  useEffect(()=>{
    if(scope!=='all'&&!scopes.includes(scope))setScope('all');
  },[scope,scopes]);
  const navIds = useMemo(() => {
    const out=CLARITY_LANES.flatMap(lane=>filtered[lane].map(({group,row})=>`${group}:${row.id}`));
    const recentData=recent.data;
    if(recentData?.ok)for(const row of recentData.items)if(!gone.has(row.id))out.push(`recent:${row.id}`);
    return out;
  },[filtered,recent.data,gone]);

  const open = useCallback(async (id: string) => {
    try {
      const node = await get<NodeDTO>('node', { id });
      if (node.deletedAt || node.archivedAt) throw new ApiError(404, 'node_not_found', L2.itemGone);
      navigate(nodePath(id));
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        showNotice(L2.itemGone);
        setGone((current) => new Set(current).add(id));
        invalidate('cockpit');
      } else {
        navigate(nodePath(id));
      }
    }
  }, []);

  const nav = useListNav(navIds, (navId) => void open(navId.slice(navId.indexOf(':') + 1)));
  const onOpen = useCallback((row: TaskRow) => void open(row.id), [open]);

  return (
    <div className="cockpit-overview cockpit-clarity" data-design="clarity-layers">
      <header className="clarity-hero">
        <span className="clarity-eyebrow">YOUR DAILY COMMAND CENTER</span>
        <h2>A clearer day, at a glance.</h2>
        <p>Urgent decisions, important follow-ups and what comes next — with context.</p>
      </header>
      <KpiStrip queries={queries} />
      <div className="clarity-filterbar" role="group" aria-label="Filter Cockpit work">
        <span className="clarity-filter-label">QUICK VIEW</span>
        <div className="clarity-filter-scopes" role="group" aria-label="Workstream filter">
          <button type="button" className={scope==='all'?'clarity-filter is-active':'clarity-filter'}
            aria-pressed={scope==='all'} onClick={()=>setScope('all')}>All work</button>
          {scopes.slice(0,3).map(name=><button key={name} type="button"
            className={scope===name?'clarity-filter is-active':'clarity-filter'}
            aria-pressed={scope===name} onClick={()=>setScope(name)}>{name}</button>)}
          {scopes.length>3?<select className="clarity-filter-more"
            aria-label="More workstreams" value={scopes.slice(3).includes(scope)?scope:''}
            onChange={event=>setScope(event.target.value||'all')}>
            <option value="">More workstreams…</option>
            {scopes.slice(3).map(name=><option key={name} value={name}>{name}</option>)}
          </select>:null}
        </div>
        <label className="clarity-search">
          <Icon name="search" size={15}/>
          <input type="search" aria-label="Search Cockpit cards"
            value={search} onChange={event=>setSearch(event.target.value)}
            placeholder="Search current cards…" />
        </label>
      </div>
      <div className="cockpit-command-grid clarity-lane-stack">
        {CLARITY_LANES.map(lane=><ClarityLane key={lane} lane={lane}
          items={filtered[lane]} allItems={clarity[lane]}
          queries={queries} filtered={scope!=='all'||Boolean(search.trim())}
          activeId={nav.activeId} onSelect={nav.setActiveId} onOpen={onOpen}/>)}
      </div>
      <div className="clarity-agent-feed"><UnconfirmedFeed/></div>
      <div className="cockpit-recent-lane clarity-recent" aria-label="Recently updated work">
        <RecentTimeline query={queries.recent} gone={gone}
          activeId={nav.activeId} onOpen={onOpen} onSelect={nav.setActiveId}/>
      </div>
    </div>
  );
}

const Board = lazy(() => import('./CockpitBoard'));
const Week = lazy(() => import('./CockpitWeek'));

const VIEW_META: Record<CockpitViewId, { label: string; icon: IconName }> = {
  overview: { label: L2.cockpitViewOverview, icon: 'overview' },
  board: { label: L2.cockpitViewBoard, icon: 'board' },
  week: { label: L2.cockpitViewWeek, icon: 'week' },
};

/** Cockpit: header with the view switcher (persisted in `kbw:v1:cockpit-view`) and the active view. */
export function Cockpit() {
  const appPath = useAppPath();
  const explicitView = new URLSearchParams(appPath.split('?')[1] ?? '').get('view');
  const [view, setView] = useState<CockpitViewId>(() =>
    explicitView && COCKPIT_VIEWS.includes(explicitView as CockpitViewId)
      ? explicitView as CockpitViewId : readJson(KEYS.cockpitView, validateCockpitView, 'overview'));
  useEffect(() => {
    if (explicitView && COCKPIT_VIEWS.includes(explicitView as CockpitViewId)) {
      setView(explicitView as CockpitViewId);
    }
  }, [explicitView]);
  const choose = (next: CockpitViewId) => {
    setView(next);
    writeJson(KEYS.cockpitView, next);
    navigate(`/?view=${next}`, { replace: true });
  };
  return (
    <section className="page cockpit" aria-labelledby="page-title">
      <div className="section-head">
        <h1 id="page-title">{L2.cockpitHeading}</h1>
        <div className="form-actions">
          <div className="segmented" role="group" aria-label={L2.cockpitViewLabel}>
            {COCKPIT_VIEWS.map((id) => (
              <button
                key={id}
                type="button"
                className={view === id ? 'btn is-active' : 'btn'}
                aria-pressed={view === id}
                onClick={() => choose(id)}
              >
                <Icon name={VIEW_META[id].icon} />
                <span>{VIEW_META[id].label}</span>
              </button>
            ))}
          </div>
          <button
            type="button"
            className="btn btn-icon btn-primary"
            aria-label={L2.quickAddEntry}
            title={L2.quickAddEntry}
            onClick={() => openQuickAdd()}
          >
            <Icon name="plus" />
          </button>
        </div>
      </div>
      {view === 'overview' ? <CockpitOverview /> : null}
      <Suspense
        fallback={
          <p className="muted" role="status">
            {L.loading}
          </p>
        }
      >
        {view === 'board' ? <Board /> : null}
        {view === 'week' ? <Week /> : null}
      </Suspense>
    </section>
  );
}
