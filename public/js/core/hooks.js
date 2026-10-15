// 描画を呼び出すための「つなぎ」と、画面の上に出る短い通知（toast）。
// 通信などが、描画（app/render.js）を直接 import しなくて済むように、起動時に main.js が setRenderer(render) で登録する。

import { ui } from './state.js';

let renderFn = () => {};

export const setRenderer = (fn) => { renderFn = fn; };

export const requestRender = () => renderFn();

let toastTimer = null;

export function toast(text) {
  ui.toast = text;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { ui.toast = null; requestRender(); }, 3500);
  requestRender();
}
