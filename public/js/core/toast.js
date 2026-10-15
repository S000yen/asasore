// 画面の上に出る、短い通知を出す（3.5秒で消える）。

import { requestRender } from './hooks.js';
import { ui } from './state.js';

let toastTimer = null;

export function toast(text) {
  ui.toast = text;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { ui.toast = null; requestRender(); }, 3500);
  requestRender();
}
