// メニュー。

import { escN } from '../../lib/format.js';
import { menuIcon } from '../../lib/icons.js';

export const menuSheet = (v) => {
  const host = v.me.isHost;
  const item = (cls, attrs, label, side = '', icon = '') => `<button class="item ${cls}" ${attrs}>${icon ? menuIcon(icon) : ''}<span class="lbl">${label}</span>${side ? `<span class="side">${side}</span>` : ''}</button>`;
  return `<h3>メニュー</h3><div class="menu-list">
      <div class="group">
        ${item('', 'data-do="share"', '招待リンクを共有', '', 'share')}
        ${item('', 'data-do="openRename"', '表示名', escN(v.me.name, 16), 'name')}
        ${item('', 'data-do="sheet" data-kind="players"', '参加者一覧', `${v.players.length}人`, 'players')}
        ${item('', 'data-do="sheet" data-kind="howto"', '遊び方', '', 'howto')}
        <div class="seg">${[[false, '参戦'], [true, '観戦']].map(([val, label]) => `<button class="btn small ${(v.me.nextSpectator ?? v.me.spectator) === val ? 'on' : ''}" data-do="setSpectate" data-val="${val}">${label}</button>`).join('')}</div>
      </div>
      ${host ? `<div class="group"><p class="group-label">主催者</p>
        ${v.me.canReclaim ? item('', 'data-do="reclaim"', v.phase === 'vote' ? '選ぶ人を回収する' : '出題者を回収する', '', 'reclaim') : ''}
        ${item('', 'data-do="sheet" data-kind="settings"', 'ルール設定', '', 'settings')}
        ${item('', v.history.length ? 'data-do="resetRoom"' : 'disabled', '記録をリセット', '', 'reset')}
        ${item('', 'data-do="sheet" data-kind="transfer"', '主催者を譲る', '', 'transfer')}
        ${v.removed.length ? item('', 'data-do="sheet" data-kind="allow"', '再入室を許可', `${v.removed.length}人`, 'allow') : ''}
      </div>` : ''}
      <div class="group">
        ${item('danger', 'data-do="leave"', '退出する', '', 'leave')}
        ${host ? item('danger', 'data-do="closeRoom"', '部屋を閉じる', '', 'close') : ''}
      </div>
    </div>`;
};
