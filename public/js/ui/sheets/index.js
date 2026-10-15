// 下から出るシート。種類（ui.sheet.kind）ごとの中身を、外枠で包む。
// 短いシート（表示名、遊び方、参加者一覧、人を選ぶシート）は、ここにまとめてある。

import { drafts, state, ui } from '../../core/state.js';
import { esc, escN } from '../../lib/format.js';
import { badgeHost, badgeSpec } from '../../lib/icons.js';
import { historySheet } from './history.js';
import { menuSheet } from './menu.js';
import { settingsSheet } from './settings.js';

// 人を選ぶボタンの並び。対象がいなければ、その旨を出す。
const pickButtons = (kind, list) => list.map((p) => `<button class="btn" data-do="pick" data-kind="${kind}" data-id="${esc(p.id)}">${escN(p.name, 24)}${p.spectator ? '（観戦中）' : ''}${p.connected === false ? '（離席中）' : ''}</button>`).join('') || '<p class="hint">対象の人がいません。</p>';

const renameSheet = (v) => {
  return `<h3>表示名を変える</h3><div class="stack">
      <label class="field"><span>表示名</span><input id="renameInput" type="text" data-draft="rename" maxlength="200" autocomplete="off" value="${esc(drafts.rename)}"></label>
      <button class="btn primary block" data-do="doRename">変更する</button></div>`;
};

const howtoSheet = (v) => {
  return `<h3>遊び方</h3><div class="howto">${state.howtoHtml ?? '<p class="hint">読み込んでいます…</p>'}</div>`;
};

const playersSheet = (v) => {
  const host = v.me.isHost;
  // 全員が見られる。外せるのは主催者だけ（自分自身はタップしても何も起きない）
  const row = (p) => {
    const me = p.id === v.me.id;
    const inner = `${p.isHost ? badgeHost : ''}${p.spectator ? badgeSpec : ''}<span class="pname">${esc(p.name)}</span>${me ? '<span class="tag">あなた</span>' : ''}${p.connected === false ? '<span class="tag">離席中</span>' : ''}`;
    return host && !me
      ? `<button class="btn prow" data-do="pick" data-kind="remove" data-id="${esc(p.id)}">${inner}</button>`
      : `<div class="prow${me ? ' me' : ''}">${inner}</div>`;
  };
  return `<h3>参加者一覧</h3><div class="plist">${v.players.map(row).join('')}</div>`;
};

const transferSheet = (v) => {
  const others = v.players.filter((p) => p.id !== v.me.id);
  return `<h3>主催者を譲渡する</h3><div class="menu">${pickButtons('transfer', others.filter((p) => p.connected))}</div>`;
};

const allowSheet = (v) => {
  return `<h3>再入室を許可する</h3><div class="menu">${pickButtons('allow', v.removed)}</div>`;
};

const chooserSheet = (v) => {
  return `<h3>選ぶ人を任せる</h3><div class="menu"><button class="btn" data-do="randomChooser">ランダムで指名する</button>${pickButtons('chooser', v.players.filter((p) => p.connected && p.id !== v.chooserId))}</div>`;
};

const presenterSheet = (v) => {
  return `<h3>出題者を指名する</h3><div class="menu">
      <button class="btn" data-do="randomPresenter">ランダムで指名する</button>
      ${pickButtons('presenter', v.players.filter((p) => p.connected && p.id !== v.presenterId))}</div>`;
};

const SHEETS = { menu: menuSheet, history: historySheet, rename: renameSheet, settings: settingsSheet, transfer: transferSheet, howto: howtoSheet, players: playersSheet, allow: allowSheet, chooser: chooserSheet, presenter: presenterSheet };

export function sheetHtml() {
  if (!ui.sheet) return '';
  const inner = Object.hasOwn(SHEETS, ui.sheet.kind) ? SHEETS[ui.sheet.kind](state.view) : '';
  return `<div class="scrim" data-do="scrim"><div class="sheet"><button class="x" data-do="closeSheet" aria-label="閉じる">×</button>${inner}</div></div>`;
}
