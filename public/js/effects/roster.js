// ロビーの参加者：床で跳ね続ける名前の札と、タップで横から飛ぶ弾。

import { state } from '../core/state.js';
import { prefersReducedMotion } from './ambient.js';
import { esc, escN } from '../lib/format.js';
import { badgeHost, badgeSpec } from '../lib/icons.js';

let reduceMotion = false; // 動きを減らす設定のとき、動かさない（startRosterLoop で決める）

// ロビーの参加者：床がトランポリンのように、それぞれが跳ね続ける。
// 互いにはぶつからない。左右の壁では普通に跳ね返る。天井はないが、跳ねる高さの上限は枠の中に収まる。
// 跳ね具合は名前の長さしだい（文字が少ないほど高く跳ねる）。
const GRAVITY = 1500; // px/s²
const sprites = new Map(); // playerId -> {x,y,vx,vy,w,h,sq}
const bullets = []; // 横から時々飛んでくる弾 {id,x,y,dir,ox}
let bulletId = 0, nextShot = 1.5, lastTapAt = -1e9;
const bulletTf = (b) => `translate(${b.x}px,${b.y}px) rotate(${b.dir > 0 ? 90 : -90}deg)`; // 「A」のてっぺんが、飛んでいく向き
// 弾を1発打つ（発射数の制限はなし）
function fireBullet(f, dir, y) {
  const W = f.clientWidth;
  const b = { id: ++bulletId, dir, x: dir > 0 ? 0 : W, y, ox: dir > 0 ? 0 : W, hit: false };
  bullets.push(b);
  f.insertAdjacentHTML('beforeend', `<i class="bullet" data-b="${b.id}" style="transform:${bulletTf(b)}">A</i>`);
}

const BULLET_SPEED = 520; // px/s
// 弾が当たったときの横速度：発射地点に近いほど猛烈に速く、遠いほどゆっくり（向きは弾の進行方向）
const hitSpeed = (dist01) => 15 + 985 * Math.pow(1 - dist01, 2.2);
const bounceRatio = (name) => 1 - (Math.min(20, Math.max(1, [...name].length)) - 1) / 19 * 0.65; // 1文字=100%、20文字=35%
function spriteOf(p) {
  let s = sprites.get(p.id);
  if (!s) {
    const sgn = Math.random() < 0.5 ? -1 : 1;
    s = { x: 16 + Math.random() * 200, y: 200 - Math.random() * 120, vx: sgn * (28 + Math.random() * 40), vy: 0, w: 0, h: 0, sq: 0 };
    sprites.set(p.id, s);
  }
  return s;
}
const spriteTf = (s) => `translate(${s.x}px,${s.y}px) scale(${1 + 0.18 * s.sq},${1 - 0.28 * s.sq})`;
// 名前がとても長い人は、跳ねも横移動もせず、横幅いっぱいで、いちばん下に置く
const LONG_NAME = 20;
const isLongName = (name) => [...String(name)].length > LONG_NAME;
export function rosterHtml() {
  const players = state.view.players;
  for (const id of [...sprites.keys()]) if (!players.some((p) => p.id === id)) sprites.delete(id);
  const items = players.map((p) => {
    const s = spriteOf(p);
    const long = isLongName(p.name);
    const tf = long ? `translate(12px,${300 - 38 - 6}px)` : spriteTf(s);
    return `<div class="sprite c${p.id === state.view.me.id ? 1 : 0}${p.connected ? '' : ' away'}${p.spectator ? ' spec' : ''}${long ? ' long' : ''}" data-pid="${esc(p.id)}" data-name="${esc(p.name)}" style="transform:${tf}">${p.isHost ? badgeHost : ''}${p.spectator ? badgeSpec : ''}${escN(p.name, long ? 17 : 14)}</div>`;
  }).join('');
  const shots = bullets.map((b) => `<i class="bullet" data-b="${b.id}" style="transform:${bulletTf(b)}">A</i>`).join('');
  return `<div class="bfield roster" id="rosterField">${items}${shots}</div>`;
}
let rosterAt = 0;
function rosterLoop(t) {
  requestAnimationFrame(rosterLoop);
  const dt = Math.min(0.05, (t - (rosterAt || t)) / 1000);
  rosterAt = t;
  const f = document.getElementById('rosterField');
  if (!f || reduceMotion) return;
  const W = f.clientWidth, H = f.clientHeight;
  // 弾：ときどき（少なめに）、左右どちらかの端から横に飛んでくる
  // 自動の弾：だれかがタップして10秒たつまでは、お休み（10秒なにもなければ、また飛ぶ）
  if (performance.now() - lastTapAt > 10000) nextShot -= dt;
  if (nextShot <= 0) {
    nextShot = 2.5 + Math.random() * 3.5; // 30秒に7発ほど
    fireBullet(f, Math.random() < 0.5 ? 1 : -1, 10 + Math.random() * Math.max(1, H - 20));
  }
  for (const b of bullets) {
    b.x += b.dir * BULLET_SPEED * dt;
    for (const el of f.querySelectorAll('.sprite')) {
      const s = sprites.get(el.dataset.pid);
      if (!s || b.hit) continue;
      if (b.x >= s.x && b.x <= s.x + s.w && b.y >= s.y && b.y <= s.y + s.h) {
        const d = Math.min(1, Math.abs(b.x - b.ox) / Math.max(1, W));
        s.vx = b.dir * hitSpeed(d); // 向きも速さも、弾しだい
        s.sq = Math.max(s.sq, 0.7);
        b.hit = true;
      }
    }
  }
  for (let i = bullets.length - 1; i >= 0; i--) {
    const b = bullets[i];
    const gone = b.hit || b.x < -10 || b.x > W + 10;
    const el = f.querySelector(`.bullet[data-b="${b.id}"]`);
    if (gone) { el?.remove(); bullets.splice(i, 1); } else if (el) el.style.transform = bulletTf(b);
  }
  for (const el of f.querySelectorAll('.sprite')) {
    const s = sprites.get(el.dataset.pid);
    if (!s) continue;
    s.w = el.offsetWidth; s.h = el.offsetHeight;
    if (el.classList.contains('long')) { // 動かさず、いちばん下に置く（複数いても重なってよい）
      s.x = 12; s.y = H - s.h - 6; s.vx = 0; s.vy = 0; s.sq = 0;
      el.style.transform = `translate(12px,${s.y}px)`;
      continue;
    }
    const m = s.w * 0.09; // 着地でぐにゃっと広がる分の余白
    const floorY = Math.max(0, H - s.h), minX = m, maxX = Math.max(minX, W - s.w - m);
    const apex = Math.max(20, (floorY - 6) * bounceRatio(el.dataset.name)); // 跳ねる高さ（枠の高さを超えない）
    const launch = Math.sqrt(2 * GRAVITY * apex);
    s.vy += GRAVITY * dt;
    s.y += s.vy * dt;
    // 横方向：速さは次の弾が当たるまで変わらない（壁で跳ね返っても、そのまま）
    s.x += s.vx * dt;
    if (s.x < minX) { s.x = minX; s.vx = Math.abs(s.vx); } else if (s.x > maxX) { s.x = maxX; s.vx = -Math.abs(s.vx); }
    if (s.y >= floorY) { s.y = floorY; s.vy = -launch; s.sq = 1; } // トランポリン：着地のたびに、同じ高さまで跳ね返す
    const top = floorY - apex - 1;
    if (s.y < top) { s.y = top; if (s.vy < 0) s.vy = 0; } // 計算の誤差で上限を超えない
    s.sq = Math.max(0, s.sq - dt * 7); // 着地の一瞬だけ、ぐにゃっと縮む
    el.style.transform = spriteTf(s);
  }
}

// ロビーの動きを始める（起動時に1回）。タップで弾が飛ぶ処理も、ここで登録する。
export function startRosterLoop() {
  reduceMotion = prefersReducedMotion();
  // タップすると、近い方の壁から、同じ高さに弾が飛ぶ（ひとり何発でも）
  document.addEventListener('pointerdown', (e) => {
    const f = e.target.closest?.('#rosterField');
    if (!f) return;
    const r = f.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    lastTapAt = performance.now();
    fireBullet(f, x < r.width / 2 ? 1 : -1, y);
  });
  requestAnimationFrame(rosterLoop);
}

// 参加者と弾の位置を、最初の状態に戻す（テスト用）
export function resetRoster() {
  sprites.clear();
  bullets.length = 0;
}
