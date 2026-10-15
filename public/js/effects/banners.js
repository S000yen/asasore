// 画面全体にかぶせる演出：投票開始の帯と、時間切れの爆弾。

import { state } from '../core/state.js';

// 投票のはじまりで、背景を紺に反転し、「投票スタート」の帯を一瞬出す。帯は #app の外に置く（描画のたびに作り直されて、動きが途切れないように）。
export function startBand() {
  document.querySelector('.startband')?.remove();
  const el = document.createElement('div');
  el.className = 'startband';
  el.setAttribute('aria-hidden', 'true');
  el.innerHTML = `<span>${state.view.settings.chooserMode === 'one' ? '正解を選べ' : '投票スタート'}</span>`;
  document.body.append(el);
  setTimeout(() => el.remove(), 1700);
}

// 時間切れで、未回答の人がいたまま進んだとき：爆弾が爆発する
export function bomb() {
  document.querySelector('.bomb')?.remove();
  const el = document.createElement('div');
  el.className = 'bomb';
  el.setAttribute('aria-hidden', 'true');
  el.innerHTML = '<div class="flash"></div><div class="boom">💥</div><div class="boomtext">時間切れ！</div>';
  document.body.append(el);
  document.body.classList.add('shake');
  setTimeout(() => document.body.classList.remove('shake'), 700);
  setTimeout(() => el.remove(), 2100);
}
