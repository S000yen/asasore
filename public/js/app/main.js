// 画面の入口：イベント（クリックや入力）の受け付けと、起動の組み立て。
// 操作の中身は app/actions.js、HTML は ui/、状態は core/、通信は net/、描画は app/render.js、動きは effects/ に分けてある。

import { handlers } from './actions.js';
import { endComposition, fitTheme, render, startComposition } from './render.js';
import { setRenderer } from '../core/hooks.js';
import { drafts, state } from '../core/state.js';
import { startBounceLoop, startTimerTicker } from '../effects/ambient.js';
import { startRosterLoop } from '../effects/roster.js';
import { setMessageHandler, startConnection } from '../net/connection.js';
import { onMessage } from '../net/messages.js';
import { loadName, loadSession } from '../net/storage.js';
import { sliderVal, tsLabel } from '../ui/components/parts.js';

const $app = document.getElementById('app');
state.session = loadSession();
state.prefName = loadName();

$app.addEventListener('click', (e) => {
  const el = e.target.closest('[data-do]');
  if (!el || el.disabled) return;
  handlers[el.dataset.do]?.(el.dataset, el, e);
});

$app.addEventListener('input', (e) => {
  const key = e.target.dataset?.draft;
  if (!key) return;
  if (key === 'code') e.target.value = e.target.value.toUpperCase();
  if (key === 'theme' && /\n/.test(e.target.value)) e.target.value = e.target.value.replace(/\n/g, '');
  drafts[key] = e.target.value;
  if (key === 'theme') fitTheme();
  if (key === 'hiragana' || key === 'theme') { // お題のプレビューだけ、作り直さずに書き換える
    const tile = document.getElementById('tpTile'), theme = document.getElementById('tpTheme');
    if (tile) tile.textContent = drafts.hiragana || '？';
    if (theme) theme.textContent = drafts.theme;
  }
});

// 制限時間のバー：動かしている間は表示だけ変えて、指を離したときに確定する
$app.addEventListener('input', (e) => {
  const el = e.target;
  if (!el.dataset?.slider) return;
  const v = sliderVal(el);
  const box = el.closest('.tslider');
  box.querySelector('.tval').textContent = tsLabel(v);
  box.querySelectorAll('.tick').forEach((t) => t.classList.toggle('on', Number(t.dataset.val) === v));
});
$app.addEventListener('change', (e) => {
  const el = e.target;
  if (!el.dataset?.slider) return;
  handlers.setTime({ ctx: el.dataset.slider, val: String(sliderVal(el)) });
});

$app.addEventListener('keydown', (e) => { // Enter で、コード入力と表示名変更を確定する（変換中は除く）
  if (e.key !== 'Enter' || e.isComposing) return;
  if (e.target.id === 'codeInput') { e.preventDefault(); handlers.join(); }
  if (e.target.id === 'themeInput') e.preventDefault(); // 題材は1行の文章として扱う（改行は入れない）
  if (e.target.id === 'renameInput') { e.preventDefault(); handlers.doRename(); }
});

// 黄色のテロップは、最初にタップしたとき全部を選択する（そのまま打ち直せるように）。2回目のタップからは、普通にカーソルを置く。
let justFocused = false;
$app.addEventListener('focusin', (e) => {
  if (e.target.id !== 'hiraInput' && e.target.id !== 'themeInput') return;
  const el = e.target;
  justFocused = true;
  setTimeout(() => { try { el.select(); el.setSelectionRange(0, el.value.length); } catch { /* 選択できなくても動く */ } }, 0);
  setTimeout(() => { justFocused = false; }, 400);
});
$app.addEventListener('mouseup', (e) => { if (justFocused && (e.target.id === 'hiraInput' || e.target.id === 'themeInput')) e.preventDefault(); }); // 離した瞬間に選択が解けるのを防ぐ

$app.addEventListener('compositionstart', () => { startComposition(); });
$app.addEventListener('compositionend', () => { endComposition(); });

// 起動：描画と通信の登録をして、動きを始め、最初の描画と接続を行う。
setRenderer(render);
setMessageHandler(onMessage);
startRosterLoop();
startBounceLoop();
startTimerTicker();
render();
startConnection();
