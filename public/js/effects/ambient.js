// 背景の動き：お題を待つあいだのロゴと、回答待ちの時計。動きを減らす設定の判定も、ここに置く。

import { state } from '../core/state.js';
import { timerInfo } from '../ui/components/parts.js';
import { PHASE } from '../../../shared/phases.js';

export const prefersReducedMotion = () => Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);

let reduceMotion = false; // 動きを減らす設定のとき、動かさない（startBounceLoop で決める）

// お題を待つあいだの、跳ね返り続けるロゴ（DVDプレイヤーの待ち受けのような）。位置は画面を作り直しても引き継ぐ。
const bounce = { x: 24, y: 18, vx: 72, vy: 54, c: 0 };
export const bounceHtml = () => `<div class="bfield" id="bounceField"><div class="blogo c${bounce.c}" id="bounceLogo" style="transform:translate(${bounce.x}px,${bounce.y}px)"><span class="bt">あ</span><span class="bl"><i></i><i></i></span></div></div>`;

let bounceAt = 0;
function bounceLoop(t) {
  requestAnimationFrame(bounceLoop);
  const dt = Math.min(0.05, (t - (bounceAt || t)) / 1000);
  bounceAt = t;
  const f = document.getElementById('bounceField'), l = document.getElementById('bounceLogo');
  if (!f || !l || reduceMotion) return;
  const maxX = Math.max(0, f.clientWidth - l.offsetWidth), maxY = Math.max(0, f.clientHeight - l.offsetHeight);
  bounce.x += bounce.vx * dt;
  bounce.y += bounce.vy * dt;
  let hit = false;
  if (bounce.x < 0) { bounce.x = 0; bounce.vx = Math.abs(bounce.vx); hit = true; } else if (bounce.x > maxX) { bounce.x = maxX; bounce.vx = -Math.abs(bounce.vx); hit = true; }
  if (bounce.y < 0) { bounce.y = 0; bounce.vy = Math.abs(bounce.vy); hit = true; } else if (bounce.y > maxY) { bounce.y = maxY; bounce.vy = -Math.abs(bounce.vy); hit = true; }
  if (hit) { bounce.c = (bounce.c + 1) % 4; l.className = `blogo c${bounce.c}`; } // 壁に当たるたび、色が変わる
  l.style.transform = `translate(${bounce.x}px,${bounce.y}px)`;
}

// お題を待つあいだの動きを始める（起動時に1回）
export function startBounceLoop() {
  reduceMotion = prefersReducedMotion();
  requestAnimationFrame(bounceLoop);
}

// 時計を 250ms ごとに書き換える（起動時に1回）
export function startTimerTicker() {
  setInterval(() => {
    const el = document.getElementById('timer');
    if (!el || state.view?.phase !== PHASE.ANSWER) return;
    const t = timerInfo();
    const tx = document.getElementById('timerText');
    if (tx && tx.textContent !== t.text) tx.textContent = t.text;
    el.classList.toggle('low', t.low);
    const ic = el.querySelector('.ticon');
    if (ic && t.limit) ic.textContent = t.low ? '💣' : '⏳';
  }, 250);
}
