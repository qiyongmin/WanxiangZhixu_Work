import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { initTheme } from './lib/theme';
import { initVisualStyle } from './lib/visualStyle';
import { initUiLayout } from './lib/uiLayout';
import { installHistoryGuard } from './lib/router';
// Self-hosted SIL OFL variable fonts; CSS unicode ranges load CJK subsets on demand.
import '@fontsource-variable/inter/wght.css';
import '@fontsource-variable/noto-sans-sc/wght.css';
import '@fontsource-variable/jetbrains-mono/wght.css';
import './styles/tokens.css';
import './styles/base.css';
import './styles/layout.css';
import './styles/components.css';
import './styles/node.css';
import './styles/phase2.css';
import './styles/phase3.css';
import './styles/phase4.css';
import './styles/kbw-primitives.css';
import './styles/focus-v2.css';
import './styles/compact-work-ui.css';
import './styles/material-preview-v2.css';
import './styles/tree-hierarchy.css';
import './styles/work-board-v3.css';
import './styles/work-detail-v3.css';
import './styles/initiative-explorer.css';
import './styles/cockpit-v4.css';
import './styles/work-ui-v5.css';
import './styles/work-ui-v5-1.css';
import './styles/work-ui-v5-2.css';
import './styles/visual-styles.css';
import './styles/focus-v2-1.css';
import './styles/office-preview-v2-1.css';
import './styles/file-versions-v2-1.css';
import './styles/materials-compact-readonly.css';
import './styles/materials-v3.css';
import './styles/initiative-explorer-v2.css';
import './styles/work-simplification-v1.css';
import './styles/work-navigation-polish-v1.css';
import './styles/agent-access-v2.css';
import './styles/cockpit-clarity-v1.css';
import './styles/settings-simplified-v2.css';
import './styles/tree-node-reorder.css';
import './styles/notebook-v3.css';
import './styles/notebook-v3-extras.css';
import './styles/l1-project-canvas-v3.css';
import './styles/work-ui-v31.css';
import './styles/work-ui-v32-precision.css';
import './styles/notebook-v33-onenote-canvas.css';
import './styles/notebook-v34-unified.css';
import './styles/ui-layout-precision.css';
import './styles/notebook-v35-rich.css';
import './styles/notebook-v35-borders.css';
import './styles/resources-hub-v1.css';
import './styles/prompt-notebook-v2.css';
import './styles/resources-workspaces-v2.css';
import './styles/agent-journal-v2.css';

initTheme();
initVisualStyle();
initUiLayout();
// Register BEFORE React's useSyncExternalStore subscriptions: on popstate the
// browser location already changed, so dirty Notes must be guarded before any
// route observer can unmount their editor.
installHistoryGuard();

const container = document.getElementById('root');
if (container) {
  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
