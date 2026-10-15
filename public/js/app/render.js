// 描画：状態から HTML を作って、変わったところだけを書き換える。段階が変わったときの演出も、ここで始める。

import { isEditing } from '../core/selectors.js';
import { state, ui } from '../core/state.js';
import { bomb, startBand } from '../effects/banners.js';
import { confetti } from '../effects/confetti.js';
import { loadHowto } from '../net/howto.js';
import { entryHtml } from '../ui/pages/entry.js';
import { roomHtml } from '../ui/pages/room.js';

let composing = false, pendingRender = false;
let lastPhaseKey = '';

function trackPhase() {
  const phase = state.view?.phase ?? '';
  document.body.dataset.phase = phase;
  const key = state.view ? `${state.view.code}:${state.view.round}:${phase}` : '';
  if (key !== lastPhaseKey) {
    ui.sel.clear(); // 段階が変わったら、編集と選択は解く
    ui.editing = false;
    if (state.view?.bombed && (phase === 'reveal' || phase === 'result') && lastPhaseKey.endsWith(':answer')) bomb();
    if (phase === 'vote' && lastPhaseKey.endsWith(':reveal')) startBand();
    if (phase === 'result' && lastPhaseKey.endsWith(':vote') && state.view.result?.winners.length) confetti();
    lastPhaseKey = key;
  }
  if (!isEditing()) { ui.editing = false; ui.sel.clear(); }
  if (state.view && ui.sel.size) { // 消えた・まだ開示されていない回答は、選択から外す
    const ok = new Set(state.view.pool.filter((c) => c.revealed).map((c) => c.answerId));
    for (const id of [...ui.sel]) if (!ok.has(id)) ui.sel.delete(id);
  }
}

export function render() {
  if (composing) { pendingRender = true; return; } // 日本語入力の変換中は作り直さない
  trackPhase();
  if (state.view && ui.sheet?.kind === 'howto') loadHowto(() => { if (ui.sheet?.kind === 'howto') render(); }); // 遊び方は、初めて開くときに読み込む（読み込めたら、描き直す）
  morphInto(document.getElementById('app'), state.view ? roomHtml() : entryHtml());
  fitTheme();
}

// 画面の更新は、全部を作り直さず、変わったところだけを書き換える。
// スクロール位置、入力中の欄（キーボード）、動いている演出が、他の人の操作で途切れないように。
function morphInto(root, html) {
  const next = document.createElement('div');
  next.innerHTML = html;
  syncChildren(root, next);
}
function syncChildren(parent, fresh) {
  const want = fresh.childNodes;
  for (let i = 0; i < want.length; i++) {
    const n = want[i], o = parent.childNodes[i];
    if (!o) { parent.appendChild(n.cloneNode(true)); continue; }
    if (o.nodeType !== n.nodeType || o.nodeName !== n.nodeName) { parent.replaceChild(n.cloneNode(true), o); continue; }
    if (n.nodeType !== 1) { if (o.nodeValue !== n.nodeValue) o.nodeValue = n.nodeValue; continue; }
    for (const a of [...o.attributes]) if (!n.hasAttribute(a.name)) o.removeAttribute(a.name);
    for (const a of n.attributes) if (o.getAttribute(a.name) !== a.value) o.setAttribute(a.name, a.value);
    if (o.nodeName === 'TEXTAREA' || o.nodeName === 'INPUT') {
      if (o !== document.activeElement && o.value !== n.value) o.value = n.value; // 入力中の欄の中身は、触らない
      continue;
    }
    syncChildren(o, n);
  }
  while (parent.childNodes.length > want.length) parent.removeChild(parent.lastChild);
}

// 題材の欄は、長くても全部見えるよう、文字の量に合わせて高さを変える
export function fitTheme() {
  const el = document.getElementById('themeInput');
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight + 4}px`;
}

// 日本語入力の変換中は、画面を作り直さない（変換が終わったら、止めていた分を描き直す）
export function startComposition() {
  composing = true;
}

export function endComposition() {
  composing = false;
  setTimeout(() => { if (pendingRender && !composing) { pendingRender = false; render(); } }, 0);
}
