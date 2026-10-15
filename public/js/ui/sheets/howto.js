// 遊び方。

import { state } from '../../core/state.js';

export const howtoSheet = (v) => {
  return `<h3>遊び方</h3><div class="howto">${state.howtoHtml ?? '<p class="hint">読み込んでいます…</p>'}</div>`;
};
