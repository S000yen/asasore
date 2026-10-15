// 反応マークが、画面の下から浮かび上がる。

import { MARKS } from '../lib/marks.js';

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
