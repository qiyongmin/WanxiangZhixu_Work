import type { ResourceLinkKind } from '../../lib/types';
import { Icon } from '../icons';

/** Local, network-free pictograms. Folder icon is the original Work folder,
 * and WSL is distinguished by a Linux penguin. Teams/SharePoint use familiar
 * brand shapes without downloading remote assets or requiring icon fonts. */
export function visualShortcutKind(kind: ResourceLinkKind, target: string) {
  return kind === 'folder' ? (/^\//.test(target) || /^\\\\wsl(?:\$|\.localhost)\\/i.test(target)
    ? 'wsl' : 'windows') : kind;
}

export function ShortcutIcon({ kind, target }: { kind: ResourceLinkKind; target: string }) {
  const visual = visualShortcutKind(kind, target);
  if (visual === 'windows') return <Icon name="folder" size={23}/>;
  if (visual === 'wsl') return (
    <svg width="29" height="29" viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <path d="M16 4.5c-5 0-7.8 4.8-7.5 10.9l-1.7 4.8c-1.1 3-.1 4.4 2.2 4.6l4 .2 3-1.2 3 1.2 4-.2c2.3-.2 3.3-1.6 2.2-4.6l-1.7-4.8C23.8 9.3 21 4.5 16 4.5Z" fill="var(--qa-penguin-ink)"/>
      <path d="M12.1 16.1c-2.6.7-4.1 2.9-4.3 7.4L6.2 27h6.9l2.9-1.3 2.9 1.3h6.9l-1.6-3.5c-.3-4.5-1.8-6.7-4.4-7.4a6.3 6.3 0 0 1-7.7 0Z" fill="var(--qa-penguin-white)"/>
      <ellipse cx="13" cy="13.3" rx="1.1" ry="1.7" fill="var(--qa-penguin-white)"/><ellipse cx="19" cy="13.3" rx="1.1" ry="1.7" fill="var(--qa-penguin-white)"/>
      <circle cx="13.2" cy="13.5" r=".55" fill="var(--qa-penguin-eye)"/><circle cx="18.8" cy="13.5" r=".55" fill="var(--qa-penguin-eye)"/>
      <path d="M13.4 16.6 16 19.1l2.6-2.5L16 15.5Z" fill="var(--qa-penguin-beak)"/>
      <path d="m11 25.6-2.6 2.1h5.2l2.4-2.1 2.4 2.1h5.2L21 25.6" fill="var(--qa-penguin-feet)"/>
    </svg>
  );
  if (visual === 'teams') return (
    <svg width="29" height="29" viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <circle cx="24.7" cy="9.1" r="4" fill="var(--qa-teams-lighter)"/>
      <circle cx="17.8" cy="7.8" r="4.6" fill="var(--qa-teams-base)"/>
      <path d="M20 15h8.4v6.5c0 3-2.7 5.3-5.3 5.3-1.7 0-3-.6-4-1.8Z" fill="var(--qa-teams-mid)"/>
      <path d="M13 14.7h11.2v8.1c0 4.1-2.8 6.6-6.2 6.6-3.6 0-6.2-2.5-6.2-6.6Z" fill="var(--qa-teams-dark)"/>
      <rect x="3" y="10.8" width="16" height="17" rx="3" fill="var(--qa-teams-deep)"/>
      <path d="M7 15.2h9v2.3h-3.2v6.7h-2.5v-6.7H7Z" fill="var(--qa-penguin-white)"/>
    </svg>
  );
  if (visual === 'sharepoint') return (
    <svg width="29" height="29" viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <circle cx="20.5" cy="11.5" r="8" fill="var(--qa-sharepoint-base)"/>
      <circle cx="22.7" cy="20.8" r="7.1" fill="var(--qa-sharepoint-light)"/>
      <circle cx="13.5" cy="23.3" r="5.5" fill="var(--qa-sharepoint-deep)"/>
      <rect x="3" y="9" width="15" height="16.5" rx="2.5" fill="var(--qa-sharepoint-block)"/>
      <path d="M13.5 13.9c-1.1-.9-4.9-1.2-4.9.7 0 2.1 5.5 1.4 5.5 4.8 0 3.6-5.6 4.1-8.1 2.5l1.1-2c1.8 1 4.5 1.1 4.5-.2 0-1.8-5.5-1.4-5.5-4.8 0-3.1 5.1-4.5 8.4-2.4Z" fill="var(--qa-penguin-white)"/>
    </svg>
  );
  if (visual === 'eridoc') return (
    <svg width="29" height="29" viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <path d="M8 3.5h11l6 6v18.2c0 1.1-.9 1.8-2 1.8H8c-1.3 0-2-1-2-2V5.5c0-1.1.8-2 2-2Z" fill="var(--qa-eridoc-base)"/>
      <path d="M19 3.5v6h6Z" fill="var(--qa-eridoc-fold)"/>
      <rect x="9.5" y="13" width="12.7" height="2" rx="1" fill="var(--qa-penguin-white)" opacity=".8"/>
      <rect x="9.5" y="17" width="10.5" height="2" rx="1" fill="var(--qa-penguin-white)" opacity=".65"/>
      <path d="M9.5 23h11v2h-11Z" fill="var(--qa-penguin-white)" opacity=".65"/>
    </svg>
  );
  return <Icon name="open" size={22}/>;
}
