// 画面の下に固定する、主操作と、出題者・選ぶ人のチップ。

import { isEditing, state } from '../../core/state.js';
import { esc } from '../../lib/format.js';
import { ICON_SEND } from '../../lib/icons.js';

export function actionBar() {
  const v = state.view, host = v.me.isHost;
  const lock = isEditing(); // まとめの編集中は、先へ進めない（ボタンを押せなくして、理由を添える）
  let btn = '', meta = '';
  switch (v.phase) {
    case 'lobby':
      if (host) {
        const n = v.players.filter((p) => p.connected && !p.spectator).length;
        btn = `<button class="btn primary block" data-do="advance" ${n < 3 ? 'disabled' : ''}>はじめる</button>`;
        meta = n < 3 ? '3人以上で始められます' : '';
      }
      break;
    case 'topic':
      if (v.me.isPresenter) btn = '<button class="btn primary block" data-do="confirmTopic">この題で決定</button>';
      break;
    case 'answer':
      if (host) { btn = '<button class="btn primary block" data-do="advance">開示へ進む</button>' }
      break;
    case 'reveal':
      if (host) {
        const left = v.unrevealedCount;
        btn = `<button class="btn primary block" data-do="advance" ${left > 0 || lock ? 'disabled' : ''}>投票へ進む</button>`;
        if (lock) meta = 'まとめの編集中は進めません';
      }
      break;
    case 'vote':
      if (v.settings.chooserMode === 'one' ? v.me.isChooser : host) {
        btn = `<button class="btn primary block" data-do="advance" ${(v.pendingCount > 0 && v.settings.chooserMode === 'one') || lock ? 'disabled' : ''}>結果を見る</button>`;
        if (lock) meta = 'まとめの編集中は進めません';
      }
      break;
    case 'result':
      if (host) btn = '<button class="btn primary block" data-do="advance">次のラウンドへ</button>';
      break;
  }
  // 題決めの間は、出題者を丸いチップで出す。出題者本人と主催者は、タップして変更できる。
  let who = '';
  if (v.phase === 'topic') {
    const name = v.players.find((p) => p.id === v.presenterId)?.name ?? '';
    const can = v.me.canAssignPresenter;
    const inner = `<span class="av">${esc([...name][0] ?? '?')}</span><span class="who-text">出題者 <b>${esc(name)}</b></span>${can ? `<span class="who-edit">${ICON_SEND}変更</span>` : ''}`;
    who = can ? `<button class="who" data-do="sheet" data-kind="presenter">${inner}</button>` : `<div class="who">${inner}</div>`;
  }
  if (v.phase === 'vote' && v.settings.chooserMode === 'one') {
    const name = v.players.find((p) => p.id === v.chooserId)?.name ?? '';
    const can = v.me.canAssignChooser;
    const inner = `<span class="av">${esc([...name][0] ?? '?')}</span><span class="who-text">選ぶ人 <b>${esc(name)}</b></span>${can ? `<span class="who-edit">${ICON_SEND}変更</span>` : ''}`;
    who = can ? `<button class="who" data-do="sheet" data-kind="chooser">${inner}</button>` : `<div class="who">${inner}</div>`;
  }
  if (!who && v.me.spectator && !btn) who = `<button class="who" data-do="toggleSpectate"><span class="who-text">観戦中</span><span class="who-edit">参戦する</span></button>`;
  return btn || who ? `<div class="action"><div>${who}${meta ? `<p class="meta">${meta}</p>` : ''}${btn}</div></div>` : '';
}
