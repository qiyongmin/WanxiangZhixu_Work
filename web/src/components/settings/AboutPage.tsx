import { useEffect, useState } from 'react';
import { AppLink } from '../AppLink';
import packageInfo from '../../../package.json';

interface BuildInfo { builtAt?: string; sourceHash?: string; }
const APP_VERSION = packageInfo.version; // Build-time value from the release manifest.
const MATERIALS_VERSION = '3.0';

export function AboutDetails() {
  const [build, setBuild] = useState<BuildInfo | null>(null);
  const [loadError, setLoadError] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    fetch('/app/BUILD_INFO.json', { signal: controller.signal, cache: 'no-cache' })
      .then(response => { if (!response.ok) throw new Error('Build info unavailable'); return response.json() as Promise<BuildInfo>; })
      .then(setBuild)
      .catch(error => { if (!(error instanceof DOMException && error.name === 'AbortError')) setLoadError(true); });
    return () => controller.abort();
  }, []);
  const builtAt = build?.builtAt ? new Date(build.builtAt) : null;
  const validDate = builtAt && !Number.isNaN(builtAt.getTime()) ? builtAt.toLocaleString() : 'Unavailable';
  return <div className="settings-about-page" aria-label="About KB Work">
    <header className="settings-about-header">
      <img src="/app/wanxiang-work.svg" alt="" width="72" height="72" />
      <div><h2>万象知序 - Work</h2><p className="muted">收集万象，整理成序</p></div>
    </header>
    <section className="settings-about-content" aria-label="Application information">
      <dl className="settings-about-details">
        <div><dt>Application</dt><dd>KB_Work</dd></div>
        <div><dt>Author</dt><dd>Yongmin Qi</dd></div>
        <div><dt>Application version</dt><dd>{APP_VERSION}</dd></div>
        <div><dt>Materials module</dt><dd>V{MATERIALS_VERSION}</dd></div>
        <div><dt>Build date</dt><dd>{validDate}</dd></div>
        <div><dt>Build ID</dt><dd>{build?.sourceHash?.slice(0, 12) ?? 'Unavailable'}</dd></div>
        <div><dt>License</dt><dd>To be defined</dd></div>
      </dl>
      {loadError ? <p className="muted" role="status">构建信息当前不可用。</p> : null}
    </section>
  </div>;
}

/** Legacy /settings/about bookmarks remain valid. Settings now embeds About directly. */
export function AboutPage() {
  return <section className="page settings-single-page" aria-labelledby="page-title">
    <p><AppLink to="/settings">‹ 返回 Settings</AppLink></p>
    <h1 id="page-title">About</h1>
    <AboutDetails/>
  </section>;
}
