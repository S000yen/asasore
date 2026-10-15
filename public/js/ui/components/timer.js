// 回答待ちの時計（経過時間、または制限時間の残り）。

import { state } from '../../core/state.js';

// 回答待ちの時間：サーバーから届いた秒に、受け取ってからの時間を足して進める。制限時間があれば、残りを数える。
const clock = (sec) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
const elapsedNow = () => (state.view?.answerSec ?? 0) + Math.floor((performance.now() - state.viewAt) / 1000);
export const timerInfo = () => {
  const limit = state.view?.settings.timeLimit ?? 0;
  if (!limit) return { text: clock(elapsedNow()), low: false, limit: 0 };
  const left = Math.max(0, limit - elapsedNow());
  return { text: clock(left), low: left <= 10, limit };
};
export const timerHtml = () => {
  const t = timerInfo();
  return `<span class="timer${t.limit ? ' limited' : ''}${t.low ? ' low' : ''}" id="timer"><i class="ticon" aria-hidden="true">${t.limit ? (t.low ? '💣' : '⏳') : '⏱'}</i><b id="timerText">${t.text}</b></span>`;
};
