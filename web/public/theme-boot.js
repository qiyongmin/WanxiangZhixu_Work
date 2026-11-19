/* 首屏前同步设置 <html data-theme>，避免闪烁（CSP 禁止内联脚本，故为独立文件）。
 * 与 src/lib/theme.ts 保持同一约定：kbw:v1:theme ∈ {light, dark, system}，非法值/读写失败回退 system。 */
(function () {
  var root = document.documentElement;
  var choice = 'system';
  try {
    var raw = window.localStorage.getItem('kbw:v1:theme');
    var parsed = raw === null ? null : JSON.parse(raw);
    if (parsed === 'light' || parsed === 'dark' || parsed === 'system') choice = parsed;
  } catch (e) {
    choice = 'system';
  }
  var query = null;
  try {
    query = window.matchMedia('(prefers-color-scheme: dark)');
  } catch (e) {
    query = null;
  }
  function resolve(value) {
    if (value === 'light' || value === 'dark') return value;
    return query && query.matches ? 'dark' : 'light';
  }
  root.setAttribute('data-theme-choice', choice);
  root.setAttribute('data-theme', resolve(choice));
  // Independent visual skin; missing/invalid value keeps the current production UI.
  var visualStyle = 'default';
  try {
    var visualRaw = window.localStorage.getItem('kbw:v1:visual-style');
    var visualValue = visualRaw === null ? null : JSON.parse(visualRaw);
    if (visualValue === 'mountains' || visualValue === 'starship' || visualValue === 'aurora') visualStyle = visualValue;
  } catch (e) {
    visualStyle = 'default';
  }
  root.setAttribute('data-visual-style', visualStyle);
  // 跟随系统：系统设置变化时无需刷新。应用加载后由 theme.ts 通过 data-theme-choice 接管同一约定。
  if (query && typeof query.addEventListener === 'function') {
    query.addEventListener('change', function () {
      root.setAttribute('data-theme', resolve(root.getAttribute('data-theme-choice')));
    });
  }
})();
