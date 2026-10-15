// 回答待ちの時計を、画面を作り直さずに、秒だけ進める。

import { state } from '../core/state.js';
import { timerInfo } from '../ui/components/timer.js';

// 時計を 250ms ごとに書き換える（起動時に1回）
export function startTimerTicker() {
  setInterval(() => {
    const el = document.getElementById('timer');
    if (!el || state.view?.phase !== 'answer') return;
    const t = timerInfo();
    const tx = document.getElementById('timerText');
    if (tx && tx.textContent !== t.text) tx.textContent = t.text;
    el.classList.toggle('low', t.low);
    const ic = el.querySelector('.ticon');
    if (ic && t.limit) ic.textContent = t.low ? '💣' : '⏳';
  }, 250);
}
