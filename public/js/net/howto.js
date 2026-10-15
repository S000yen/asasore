// 遊び方（howto.md）の読み込み。

import { state } from '../core/state.js';
import { mdToHtml } from '../lib/markdown.js';

// 遊び方（public/howto.md）：初めて開くときに読み込んで、控えておく。
let howtoLoading = false;

export function loadHowto(onLoaded) {
  if (state.howtoHtml !== null || howtoLoading) return;
  howtoLoading = true;
  fetch('/howto.md').then((r) => (r.ok ? r.text() : Promise.reject(new Error(r.status)))).then((t) => { state.howtoHtml = mdToHtml(t); })
    .catch(() => { state.howtoHtml = '<p class="hint">読み込めませんでした。もう一度開いてください。</p>'; howtoLoading = false; setTimeout(() => { state.howtoHtml = null; }, 0); })
    .finally(() => { howtoLoading = false; onLoaded(); }); // 読み込めたら（失敗しても）、描き直してもらう
}
