import { afterEach, beforeEach } from 'vitest';
import { cleanup } from './helpers';
import { resetOverlays } from '../src/lib/keyboard';
import { resetNotices } from '../src/lib/notice';
import { resetCache } from '../src/lib/queryCache';
import { resetReminders } from '../src/lib/reminders';
import { resetMemoryStorage } from '../src/lib/storage';
import { resetThemeState } from '../src/lib/theme';
import { resetVisualStyleState } from '../src/lib/visualStyle';
import { resetUiLayoutState } from '../src/lib/uiLayout';
import { resetUi } from '../src/lib/ui';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom 尚未实现 <dialog>.showModal()/close()；这里提供与浏览器一致的最小行为。
const dialogProto = window.HTMLDialogElement.prototype as unknown as {
  showModal?: () => void;
  close?: () => void;
};
if (typeof dialogProto.showModal !== 'function') {
  dialogProto.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  dialogProto.close = function close(this: HTMLDialogElement) {
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  };
}

beforeEach(() => {
  window.localStorage.clear();
  resetMemoryStorage();
  resetCache();
  resetThemeState();
  resetVisualStyleState();
  resetUiLayoutState();
  document.documentElement.removeAttribute('data-visual-style');
  document.documentElement.removeAttribute('data-ui-layout');
  resetOverlays();
  resetNotices();
  resetReminders();
  resetUi();
  window.history.replaceState(null, '', '/app/');
});

afterEach(() => {
  cleanup();
});
