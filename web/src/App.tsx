import { useEffect, type ReactNode } from 'react';
import { AppShell } from './components/AppShell';
import { isExplorerKind } from './components/node/InitiativeExplorer';
import { BottomEntries, TopEntries } from './components/Entries';
import { LeftTree, TreeHeader } from './components/LeftTree';
import { MigrationGate } from './components/MigrationGate';
import { NoticeHost } from './components/NoticeHost';
import { AgentAccess } from './components/agent/AgentAccess';
import { ResourcesHub } from './components/resources/ResourcesHub';
import { Proposals } from './components/agent/Proposals';
import { Cockpit } from './components/cockpit/Cockpit';
import { TagPage } from './components/mytasks/TagPage';
import { CommandPalette } from './components/palette/CommandPalette';
import { SearchPage } from './components/palette/SearchPage';
import { CreateDialog } from './components/create/CreateDialog';
import { QuickAdd } from './components/quickadd/QuickAdd';
import { NotifyStatus } from './components/settings/NotifyStatus';
import { FileHubPage } from './components/files/FileHubPage';
import { SectionsAdmin } from './components/settings/SectionsAdmin';
import { NodeDetail } from './components/node/NodeDetail';
import { NodeInspector } from './components/node/NodeInspector';
import { WorkContextPanel } from './components/node/WorkContextPanel';
import { DraftGuardDialog } from './components/DraftGuardDialog';
import { installUnloadGuard } from './lib/draftGuard';
import { SettingsPage } from './components/node/SettingsPage';
import { AboutPage } from './components/settings/AboutPage';
import { AppLink } from './components/AppLink';
import { get, isMigrationRequired } from './lib/api';
import { describeError } from './lib/errors';
import { L } from './lib/labels';
import { useQuery } from './lib/queryCache';
import { installKeyboard } from './lib/keyboard';
import { startReminderScheduler } from './lib/reminders';
import { ensureCanonical, useAppPath, useRoute, type Route } from './lib/router';
import { openPalette, openQuickAdd } from './lib/ui';
import type { SchemaView, TreeView } from './lib/types';

function RouteView({ route }: { route: Route }) {
  switch (route.name) {
    case 'cockpit':
      return <Cockpit />;
    case 'search':
      return <SearchPage />;
    case 'my-tasks':
      // Historical /my-tasks deep links canonicalize to Cockpit Board.
      return <Cockpit />;
    case 'tag':
      return <TagPage key={route.tag} tag={route.tag} />;
    case 'agent':
      return <AgentAccess section="activities" />;
    case 'agent-access':
      return <AgentAccess section={new URLSearchParams(window.location.search).get('tab') === 'activities'
        ? 'activities' : 'connections'} />;
    case 'resources':
      return <ResourcesHub tab={route.tab} id={route.id} />;
    case 'proposals':
      return <Proposals />;
    case 'files':
      return <FileHubPage />;
    case 'settings':
      return <SettingsPage />;
    case 'settings-sections':
      return <SectionsAdmin />;
    case 'settings-about':
      return <AboutPage />;
    case 'node':
      return <NodeDetail key={route.id} id={route.id} tab={route.tab} />;
    default:
      return (
        <section className="page" aria-labelledby="page-title">
          <h1 id="page-title">{L.notFoundTitle}</h1>
          <p className="muted">{L.notFoundBody}</p>
          <AppLink to="/">{L.goCockpit}</AppLink>
        </section>
      );
  }
}

function FullPageMessage({ children }: { children: ReactNode }) {
  return (
    <main className="gate">
      <div className="gate-card">{children}</div>
    </main>
  );
}

export function App() {
  const path = useAppPath();
  const route = useRoute();

  // An invalid or missing Tab is corrected with replaceState (no new history entry).
  useEffect(() => {
    ensureCanonical();
  }, [path]);

  // Global shortcuts: Ctrl/Cmd+K opens the Command_Palette; N, /, J, K, Enter and Esc live in lib/keyboard.ts.
  useEffect(() => installKeyboard({ quickAdd: () => openQuickAdd(), openPalette }), []);
  useEffect(() => installUnloadGuard(), []);

  const schema = useQuery<SchemaView>('schema', (signal) => get<SchemaView>('schema', {}, { signal }));
  const migrated = schema.data?.migrated === true;
  // Reminder scheduler: starts once the Shell is mounted and the database is migrated (checks every 30 s or less).
  useEffect(() => (migrated ? startReminderScheduler() : undefined), [migrated]);
  const tree = useQuery<TreeView>('tree', (signal) => get<TreeView>('tree', {}, { signal }), { enabled: migrated });

  const gated =
    schema.data?.migrated === false || isMigrationRequired(schema.error) || isMigrationRequired(tree.error);
  if (gated) return <MigrationGate backup={schema.data?.backup} />;

  if (!schema.data) {
    if (schema.status === 'error') {
      return (
        <FullPageMessage>
          <p role="alert" className="error-text">
            {describeError(schema.error)}
          </p>
          <button type="button" className="btn" onClick={() => void schema.refetch()}>
            {L.retry}
          </button>
        </FullPageMessage>
      );
    }
    return (
      <FullPageMessage>
        <p role="status">{L.loading}</p>
      </FullPageMessage>
    );
  }

  const selectedId = route.name === 'node' ? route.id : null;
  const selectedTreeNode = tree.data?.nodes.find((row) => row.id === selectedId);
  const selectedKind = selectedTreeNode?.kind;
  const l1Explorer = Boolean(selectedKind && isExplorerKind(selectedKind) && selectedTreeNode?.depth === 1);
  // L1 Canvas belongs to the selected L1. Legacy ?child links redirect to a
  // dedicated L2/L3 route, never to an embedded child editor.
  const inspectorId = selectedId;
  const settingsContext = route.name === 'settings' || route.name === 'settings-sections' || route.name === 'settings-about';
  // Only these four top-level work pages omit the right Work Context panel.
  const noRightPanel = route.name === 'cockpit' || route.name === 'files' ||
    route.name === 'agent' || route.name === 'agent-access' || route.name === 'resources';
  const focusContext = Boolean(selectedKind &&
    (['workstream', 'campaign', 'task', 'action'].includes(selectedKind) || l1Explorer));
  const left = (
    <>
      <TopEntries route={route} />
      <div className="tree-region">
        {tree.data ? <TreeHeader /> : null}
        {tree.data ? <LeftTree view={tree.data} selectedId={selectedId} /> : null}
        {!tree.data && tree.status === 'error' ? (
          <div className="error-bar" role="alert">
            <span>
              {L.treeLoadFailed}: {describeError(tree.error)}
            </span>
            <button type="button" className="btn" onClick={() => void tree.refetch()}>
              {L.retry}
            </button>
          </div>
        ) : null}
        {!tree.data && tree.status !== 'error' ? <p className="muted tree-empty">{L.loading}</p> : null}
      </div>
      <BottomEntries route={route} />
    </>
  );

  return (
    <AppShell
      focus={focusContext || settingsContext || noRightPanel}
      fullWidthFocus={focusContext || settingsContext || noRightPanel}
      left={left}
      toolbarExtra={<NotifyStatus />}
      overlays={
        <>
          <QuickAdd />
          <CreateDialog />
          <CommandPalette />
          <DraftGuardDialog />
          <NoticeHost />
        </>
      }
      inspector={inspectorId ? (focusContext ? <WorkContextPanel id={inspectorId} /> : <NodeInspector id={inspectorId} />) : <p className="muted pane-note">{L.inspectorEmpty}</p>}>
      <RouteView route={route} />
    </AppShell>
  );
}
