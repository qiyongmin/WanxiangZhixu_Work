import { L, L4 } from '../../lib/labels';
import { AppLink } from '../AppLink';
import { BackupPanel } from '../settings/BackupPanel';
import { RemovedPanel } from '../settings/RemovedPanel';
import { AboutDetails } from '../settings/AboutPage';
import { THEMES } from '../../lib/storage';
import { useTheme } from '../../lib/theme';
import { STYLE_INFO, VISUAL_STYLES, useVisualStyle } from '../../lib/visualStyle';
import { UI_LAYOUT_INFO, UI_LAYOUTS, useUiLayout } from '../../lib/uiLayout';
import type { Theme } from '../../lib/types';
import { NotificationSettings } from '../settings/NotifyStatus';
import { Icon } from '../icons';

const THEME_LABELS: Record<Theme,string> = {light:L.themeLight,dark:L.themeDark,system:L.themeSystem};

/** A single full-width Settings workspace: metadata first, one compact Appearance section,
 * low-frequency administration collapsed. Theme and visual palette stay independent. */
export function SettingsPage(){
  const [theme,setTheme]=useTheme();
  const [style,setStyle]=useVisualStyle();
  const [uiLayout,setUiLayout]=useUiLayout();
  return <section className="page settings-single-page" aria-labelledby="page-title">
    <header className="settings-page-heading">
      <div><span className="settings-kicker">WORKSPACE PREFERENCES</span>
        <h1 id="page-title">{L.settingsTitle}</h1>
        <p className="muted">应用信息、外观与工作区设置，集中在一个页面。</p></div>
    </header>
    <section className="settings-about-card" aria-label="About">
      <div className="settings-section-kicker">ABOUT · 关于</div>
      <AboutDetails/>
    </section>
    <section className="settings-appearance-card" aria-labelledby="settings-appearance">
      <div className="settings-section-title">
        <Icon name="palette" size={19}/>
        <div><h2 id="settings-appearance">Appearance</h2>
        <p className="muted">界面布局、视觉风格与主题明暗独立切换；任务、笔记和资料保持不变。</p></div>
      </div>
      <div className="settings-theme-line settings-layout-line" role="group" aria-label="UI Layout">
        <span className="settings-control-caption">UI Layout</span>
        <div className="settings-theme-options">
          {UI_LAYOUTS.map(value=><label key={value}
              className={value===uiLayout?'settings-theme-choice is-active':'settings-theme-choice'}
              title={UI_LAYOUT_INFO[value].description}>
            <input type="radio" name="settings-ui-layout" value={value}
              checked={uiLayout===value} onChange={()=>setUiLayout(value)}/>
            <span>{UI_LAYOUT_INFO[value].name}</span>
            {value===uiLayout?<Icon name="check" size={14}/>:null}
          </label>)}
        </div>
        <span className="muted">每台设备独立记住选择，切换不改变工作数据。</span>
      </div>
      <div className="settings-theme-line" role="group" aria-label="Theme">
        <span className="settings-control-caption">Theme</span>
        <div className="settings-theme-options">
          {THEMES.map(value=><label key={value} className={value===theme?'settings-theme-choice is-active':'settings-theme-choice'}>
            <input type="radio" name="settings-theme" value={value}
              checked={theme===value} onChange={()=>setTheme(value)}/>
            <span>{THEME_LABELS[value]}</span>
          </label>)}
        </div>
      </div>
      <div className="settings-style-row" role="group" aria-label="Visual Style">
        <span className="settings-control-caption">Visual Style</span>
        <div className="settings-style-options">
          {VISUAL_STYLES.map(value=><label className={value===style?'settings-style-choice is-active':'settings-style-choice'}
              key={value} title={STYLE_INFO[value].description}>
            <input type="radio" name="settings-visual-style" value={value}
              checked={style===value} onChange={()=>setStyle(value)}/>
            <span className="visual-style-swatch" data-swatch={value} aria-hidden="true"/>
            <span>{STYLE_INFO[value].name}</span>
            {value===style?<Icon name="check" size={14}/>:null}
          </label>)}
        </div>
      </div>
    </section>
    <section className="settings-extra-grid" aria-label="Additional settings">
      <div className="settings-extra-card"><NotificationSettings/></div>
      <div className="settings-extra-card">
        <h2>{L4.settingsSectionsLink}</h2>
        <p className="muted">{L4.settingsSectionsHint}</p>
        <AppLink to="/settings/sections">Manage Sections</AppLink>
      </div>
    </section>
    <div className="settings-admin-list">
      <details className="settings-admin-disclosure" data-settings-admin="removed">
        <summary><Icon name="archive" size={17}/> Removed items <Icon name="chevron-down" size={15}/></summary>
        <RemovedPanel/>
      </details>
      <details className="settings-admin-disclosure" data-settings-admin="backup">
        <summary><Icon name="folder" size={17}/> Backup &amp; export <Icon name="chevron-down" size={15}/></summary>
        <BackupPanel/>
      </details>
    </div>
  </section>;
}
