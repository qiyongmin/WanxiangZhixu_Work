import { L } from '../lib/labels';
import type { Route } from '../lib/router';
import { AppLink } from './AppLink';
import { Icon, type IconName } from './icons';

interface EntryProps {
  to: string;
  active: boolean;
  label: string;
  icon: IconName;
}

function Entry({ to, active, label, icon }: EntryProps) {
  return (
    <li>
      <AppLink to={to} className={active ? 'entry is-active' : 'entry'} aria-current={active ? 'page' : undefined}>
        <Icon name={icon} />
        <span>{label}</span>
      </AppLink>
    </li>
  );
}

/** Cockpit remains the primary navigation destination. */
export function TopEntries({ route }: { route: Route }) {
  return (
    <nav className="entries entries-top" aria-label={L.entriesPrimaryLabel}>
      <ul>
        <Entry to="/" active={route.name === 'cockpit' || route.name === 'my-tasks'} label={L.entryCockpit} icon="cockpit" />
      </ul>
    </nav>
  );
}

/** Quiet footer group: Files, Agent access, Settings. */
export function BottomEntries({ route }: { route: Route }) {
  return (
    <nav className="entries entries-bottom" aria-label={L.entriesFooterLabel}>
      <ul>
        <Entry to="/resources" active={route.name === 'resources'} label="AI Resources" icon="blocks" />
        <Entry to="/files" active={route.name === 'files'} label={L.entryFileHub} icon="folder" />
        <Entry to="/agent/access" active={route.name === 'agent-access' || route.name === 'agent'} label={L.entryAgentAccess} icon="plug" />
        <Entry
          to="/settings"
          active={route.name === 'settings' || route.name === 'settings-sections' || route.name === 'settings-about'}
          label={L.entrySettings}
          icon="settings"
        />
      </ul>
    </nav>
  );
}
