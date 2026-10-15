// お題のテロップ（頭文字と題材）。

import { esc } from '../../lib/format.js';

export const telop = (t) => t
  ? `<div class="telop"><div class="tile" id="tpTile">${esc(t.hiragana || '？')}</div><div class="telop-text"><span class="tiny">で始まる</span><strong id="tpTheme">${esc(t.theme)}</strong><span class="tiny">といえば？</span></div></div>`
  : '';
