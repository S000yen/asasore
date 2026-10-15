// 画面にかぶせる演出：結果の紙吹雪、反応マーク、投票開始の帯、時間切れの爆弾。
// どれも #app の外に出すので、描画のたびに消えない。

import { state } from '../core/state.js';
import { prefersReducedMotion } from './ambient.js';
import { MARKS } from '../lib/icons.js';

// 結果の発表：画面の下の左右から、クラッカーのように紙吹雪が飛び出す。#app の外の canvas に描く（描画のたびに消されないように）。
export function confetti() {
  if (prefersReducedMotion()) return;
  document.querySelector('.confetti')?.remove();
  const cv = document.createElement('canvas');
  cv.className = 'confetti';
  cv.setAttribute('aria-hidden', 'true');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const W = window.innerWidth, H = window.innerHeight;
  cv.width = W * dpr; cv.height = H * dpr;
  document.body.append(cv);
  const g = cv.getContext('2d');
  g.scale(dpr, dpr);
  const colors = ['#ffd83d', '#d93a2b', '#16213a', '#ffffff', '#ff8a3d', '#4aa8d8'];
  const parts = [];
  const shoot = (fromLeft, delay) => {
    for (let i = 0; i < 70; i++) {
      const spread = (Math.random() - 0.5) * 0.7; // 扇のように広がる
      const ang = (fromLeft ? -Math.PI * 0.36 : -Math.PI * 0.64) + spread;
      const sp = (0.55 + Math.random() * 0.6) * Math.min(1500, H * 1.55);
      parts.push({
        x: fromLeft ? W * 0.06 : W * 0.94, y: H + 8, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp,
        w: 6 + Math.random() * 6, h: 3 + Math.random() * 4, rot: Math.random() * 6.28, vr: (Math.random() - 0.5) * 18,
        c: colors[(Math.random() * colors.length) | 0], round: Math.random() < 0.25, life: 2.2 + Math.random() * 1.2, age: -delay,
      });
    }
  };
  shoot(true, 0); shoot(false, 0); shoot(true, 0.28); shoot(false, 0.28);
  let last = performance.now();
  const step = (now) => {
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    g.clearRect(0, 0, W, H);
    let alive = 0;
    for (const p of parts) {
      p.age += dt;
      if (p.age < 0) { alive += 1; continue; }
      if (p.age > p.life) continue;
      alive += 1;
      p.vx *= Math.pow(0.12, dt); p.vy = p.vy * Math.pow(0.12, dt) + 820 * dt; // 空気の抵抗と重力
      p.x += p.vx * dt; p.y += p.vy * dt; p.rot += p.vr * dt;
      g.globalAlpha = Math.min(1, (p.life - p.age) / (p.life * 0.3));
      g.fillStyle = p.c;
      g.save(); g.translate(p.x, p.y); g.rotate(p.rot);
      if (p.round) { g.beginPath(); g.arc(0, 0, p.h, 0, 6.28); g.fill(); }
      else g.fillRect(-p.w / 2, -p.h / 2, p.w, p.h * Math.abs(Math.cos(p.rot * 1.7) * 0.8 + 0.2));
      g.restore();
    }
    if (alive) requestAnimationFrame(step); else cv.remove();
  };
  requestAnimationFrame(step);
}

// 反応マーク：画面の下から、ふわっと浮かび上がる。#app の外に出す（描画のたびに消えないように）。
export function floatMark(kind) {
  const mark = MARKS[kind];
  if (!mark) return;
  let box = document.querySelector('.floaters');
  if (!box) { box = document.createElement('div'); box.className = 'floaters'; box.setAttribute('aria-hidden', 'true'); document.body.append(box); }
  if (box.childElementCount > 60) box.firstElementChild.remove();
  const el = document.createElement('span');
  el.className = 'float';
  el.textContent = mark;
  el.style.left = `${8 + Math.random() * 84}%`;
  el.style.setProperty('--sway', `${Math.round((Math.random() - 0.5) * 80)}px`);
  el.style.setProperty('--rise', `${55 + Math.round(Math.random() * 25)}vh`);
  el.style.fontSize = `${28 + Math.round(Math.random() * 14)}px`;
  el.addEventListener('animationend', () => el.remove());
  box.append(el);
}

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
