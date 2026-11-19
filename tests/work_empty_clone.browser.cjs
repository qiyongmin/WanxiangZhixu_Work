/* Read-only acceptance for an actually empty KB_Work checkout.
 * Run with a locally installed Playwright, or an explicit
 * KB_WORK_PLAYWRIGHT_PATH. Never depend on another user's project directory.
 */
const assert = require('node:assert/strict');
const net = require('node:net');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { chromium } = require(process.env.KB_WORK_PLAYWRIGHT_PATH || 'playwright');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const port = () => new Promise((resolve) => {
  const server = net.createServer();
  server.listen(0, '127.0.0.1', () => { const p = server.address().port; server.close(() => resolve(p)); });
});
(async () => {
  const p = await port();
  const base = 'http://127.0.0.1:' + p;
  const server = spawn('bash', ['./start.sh', String(p), '--foreground', '--no-restart', '--no-browser'], {
    cwd: path.resolve(__dirname, '..'), stdio: 'ignore',
  });
  let browser;
  try {
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(base + '/api/work-hub?view=schema')).ok) break;
      } catch { /* retry */ }
      await pause(150);
    }
    browser = await chromium.launch({headless: true});
    const page = await browser.newPage({viewport: {width: 1440, height: 900}});
    const errors = [];
    const crossOriginRequests = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('request', request => {
      if (/^https?:/.test(request.url()) && !request.url().startsWith(base + '/'))
        crossOriginRequests.push(request.url());
    });
    await page.goto(base + '/app/', {waitUntil: 'domcontentloaded'});
    await page.locator('.toolbar-brand-logo').waitFor({timeout:15000});
    await page.locator('.cockpit-command-grid').waitFor({timeout:15000});
    assert.equal(await page.title(), '万象知序 · Work');
    assert.ok((await page.locator('link[rel=icon]').getAttribute('href')).endsWith('wanxiang-favicon.svg'));
    assert.equal(await page.locator('[data-group="recent"] .cockpit-item').count(), 0);
    assert.equal(await page.locator('.unconfirmed-feed').count(), 1);
    assert.equal(await page.locator('.unconfirmed-feed').evaluate((el) => el.open), false);
    await page.getByText('Projects', {exact:true}).waitFor();
    await page.getByText('Initiatives', {exact:true}).waitFor();
    const treeResponse = await page.request.get(base+'/api/work-hub?view=tree');
    assert.equal(treeResponse.status(), 200);
    const tree = (await treeResponse.json()).data;
    assert.equal(tree.nodes.length, 0);
    assert.equal(tree.sections.some((s) => s.title === 'Projects'), true);
    // Font files are served from the clone itself, never from a font CDN.
    // The browser loads only the relevant unicode-range WOFF2 subsets.
    const fonts = await page.evaluate(async () => {
      const faces = [
        ['Inter Variable', 'Work'],
        ['Noto Sans SC Variable', '万象知序'],
        ['JetBrains Mono Variable', 'const'],
      ];
      const loaded = [];
      for (const [family, sample] of faces) {
        const matches = await document.fonts.load('400 14px "' + family + '"', sample);
        loaded.push({family, matches: matches.length, ok: document.fonts.check('400 14px "' + family + '"', sample)});
      }
      return {loaded, body: getComputedStyle(document.body).fontFamily};
    });
    assert.ok(fonts.body.includes('Inter Variable'), 'UI body must use the bundled open font stack');
    assert.ok(fonts.loaded.every(face => face.matches > 0 && face.ok), JSON.stringify(fonts.loaded));
    for (const name of ['inter-OFL-1.1.txt', 'noto-sans-sc-OFL-1.1.txt',
                        'jetbrains-mono-OFL-1.1.txt', 'lucide-ISC.txt', 'radix-dialog-MIT.txt']) {
      const notice = await page.request.get(base + '/app/licenses/' + name);
      assert.equal(notice.status(), 200, 'bundled license missing: ' + name);
    }

    // Four skins × light/dark × both layouts × four widths, against a zero-data clone.
    // Changing attributes here is visual-only: never call the Work write API.
    let combinations = 0;
    for (const style of ['default', 'mountains', 'starship', 'aurora']) {
      for (const theme of ['light', 'dark']) {
        for (const layout of ['classic', 'precision']) {
          for (const width of [1440, 820, 390, 320]) {
            await page.setViewportSize({width, height: 860});
            const view = await page.evaluate(({style, theme, layout}) => {
              const root = document.documentElement;
              root.dataset.visualStyle = style;
              root.dataset.theme = theme;
              if (layout === 'precision') root.dataset.uiLayout = layout;
              else delete root.dataset.uiLayout;
              const computed = getComputedStyle(document.body);
              return {
                visualStyle: root.dataset.visualStyle,
                theme: root.dataset.theme,
                layout: root.dataset.uiLayout || 'classic',
                background: computed.backgroundColor,
                bodyFont: computed.fontFamily,
                horizontalOverflow: root.scrollWidth - root.clientWidth,
                title: document.title,
              };
            }, {style,theme,layout});
            assert.equal(view.visualStyle, style);
            assert.equal(view.theme, theme);
            assert.equal(view.layout, layout);
            assert.ok(view.background !== '', 'missing CSS theme background');
            assert.ok(view.bodyFont.includes('Inter Variable'), 'font fallback unexpected');
            assert.ok(view.horizontalOverflow <= 4,
              'horizontal overflow ' + JSON.stringify({style,theme,layout,width,delta:view.horizontalOverflow}));
            combinations++;
          }
        }
      }
    }
    // Only same-origin resources are permitted by the Work shell CSP.
    const fontAssets = await page.evaluate(() =>
      Array.from(document.fonts).filter(f => f.family.includes('Variable') && f.status === 'loaded').length);
    assert.ok(fontAssets > 0, 'no self-hosted variable font faces loaded');
    assert.deepEqual(crossOriginRequests, [], 'No third-party font/icon/CSS network requests');
    assert.deepEqual(errors, []);
    console.log('PASS empty KB_Work clone browser: self-hosted fonts, 5 license notices, ' +
      combinations + ' UI combinations, four sections, zero records, responsive');
  } finally {
    await browser?.close();
    server.kill('SIGTERM');
    await Promise.race([new Promise((resolve) => server.once('exit', resolve)), pause(1500)]);
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
