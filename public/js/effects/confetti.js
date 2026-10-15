// 結果発表の紙吹雪。

import { prefersReducedMotion } from '../lib/motion.js';

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
