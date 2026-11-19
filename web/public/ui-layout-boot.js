/* KB_Work V4.0: apply the stored UI layout before first paint.
 * Runs before React; only recognizes the opt-in Precision presentation.
 * Does not touch Theme, Visual Style, routes or workspace data. */
(function () {
  try {
    var saved = JSON.parse(window.localStorage.getItem('kbw:v1:ui-layout') || 'null');
    if (saved === 'precision') document.documentElement.setAttribute('data-ui-layout', 'precision');
    else document.documentElement.removeAttribute('data-ui-layout');
  } catch (_) {
    document.documentElement.removeAttribute('data-ui-layout');
  }
}());
