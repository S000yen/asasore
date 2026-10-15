// 小さな部品の HTML：参加者の並び、進み具合、お題のテロップ、時計、制限時間のバー、反応マーク、確認ダイアログ、通知。

import { isEditing, state, ui } from '../../core/state.js';
import { esc, escN } from '../../lib/format.js';
import { MARKS, badgeHost } from '../../lib/icons.js';
import { TIME_LIMIT_MIN, TIME_LIMIT_MAX } from '../../../../shared/rules.js';

const chips = (list, mark) => `<div class="chips">${list.map((p) =>
  `<span class="chip ${p.connected ? '' : 'away'}${p.id === state.view?.me.id ? ' me' : ''}">${p.isHost ? badgeHost : ''}${escN(p.name, 12)}${mark && mark(p) ? '<span class="mark">✓</span>' : ''}${p.connected ? '' : '<span class="tag">離席中</span>'}</span>`).join('')}</div>`;

// 参加者の進み具合（回答済み・投票済み）。枠は付けず、見出しの横に数だけ出す
export const progress = (label, list, done, side = '') => `<div class="progress"><h2><span>${label} ${list.filter(done).length}/${list.length}</span>${side}</h2>${chips(list, done)}</div>`;

export const telop = (t) => t
  ? `<div class="telop"><div class="tile" id="tpTile">${esc(t.hiragana || '？')}</div><div class="telop-text"><span class="tiny">で始まる</span><strong id="tpTheme">${esc(t.theme)}</strong><span class="tiny">といえば？</span></div></div>`
  : '';

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

// 回答の制限時間：5〜180秒のバー。いちばん右が「なし」。目盛りをタップすると、その時間になる。
const TS_MIN = TIME_LIMIT_MIN, TS_MAX = TIME_LIMIT_MAX, TS_NONE = TS_MAX + 25; // 右端の「なし」は、180秒の目盛りと重ならないよう、少し離しておく
const TS_TICKS = [TS_MIN, 30, 60, 90, 120, 150, TS_MAX, 0];
const tsPos = (v) => (Number(v) === 0 ? TS_NONE : Number(v));
export const tsLabel = (v) => (Number(v) === 0 ? 'なし' : `${v}秒`);
export function timeSliderHtml(value, ctx, disabled = false) {
  const frac = (pos) => (pos - TS_MIN) / (TS_NONE - TS_MIN);
  const ticks = TS_TICKS.map((v) => `<button type="button" class="tick${Number(value) === v ? ' on' : ''}" style="--f:${frac(tsPos(v))}" data-do="setTime" data-ctx="${ctx}" data-val="${v}" ${disabled ? 'disabled' : ''}>${v === 0 ? 'なし' : v}</button>`).join('');
  return `<div class="tslider" data-ctx="${ctx}">
    <div class="thead"><h2>回答の制限時間</h2><span class="tval">${tsLabel(value)}</span></div>
    <input type="range" class="trange" min="${TS_MIN}" max="${TS_NONE}" step="5" value="${tsPos(value)}" data-slider="${ctx}" style="--f:${frac(tsPos(value))}" aria-label="回答の制限時間" ${disabled ? 'disabled' : ''}>
    <div class="ticks">${ticks}</div>
  </div>`;
}

// つまみの値。いちばん右の「なし」は、制限時間 0 に戻す。
export const sliderVal = (el) => { const n = Number(el.value); return n > TS_MAX ? 0 : n; };

// つまみの位置を、止まれる位置に寄せる。180秒と「なし」の間（目盛りを離すために空けた所）は、近いほうへ吸い付く。
export const snapPos = (pos) => {
  const n = Number(pos);
  if (n <= TS_MAX) return n;
  return n - TS_MAX < (TS_NONE - TS_MAX) / 2 ? TS_MAX : TS_NONE;
};

// 矢印キーで、180秒と「なし」の間を1回で跳ぶ（寄せるだけだと、180秒から右へ進めなくなる）。跳ばないときは null（ふつうに動かす）。
export const keyJump = (pos, key) => {
  const n = Number(pos);
  if (n === TS_MAX && (key === 'ArrowRight' || key === 'ArrowUp')) return TS_NONE;
  if (n === TS_NONE && (key === 'ArrowLeft' || key === 'ArrowDown')) return TS_MAX;
  return null;
};

export function reactBarHtml() {
  const lock = isEditing();
  return `<div class="reactbar">${Object.entries(MARKS).map(([k, m]) => `<button class="react" ${lock ? 'disabled' : `data-do="react" data-kind="${k}"`} aria-label="${{ like: 'いいね', bad: 'バッド', cheer: '応援', laugh: '笑い' }[k]}">${m}</button>`).join('')}</div>`;
}

export function modalHtml() {
  const m = ui.modal;
  if (!m) return '';
  return `<div class="scrim dialog" data-do="noop"><div class="sheet"><button class="x" data-do="modalCancel" aria-label="閉じる">×</button>
    ${m.quote ? `<p class="vquote">${esc(m.quote)}</p>` : `<p>${esc(m.body)}</p>`}
    <div class="dialog-actions"><button class="btn ${m.danger ? 'danger' : 'primary'} go" data-do="modalOk">${esc(m.ok)}</button></div>
  </div></div>`;
}

export const toastHtml = () => (ui.toast ? `<div class="toast" role="status">${esc(ui.toast)}</div>` : '');
