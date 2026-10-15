// ロビー：参加者の一覧。

import { state } from '../../core/state.js';
import { rosterHtml } from '../../effects/roster.js';
import { escN } from '../../lib/format.js';
import { ICON_PENCIL } from '../../lib/icons.js';

export function lobbyHtml() {
  const v = state.view;
  return `
    <div class="listhead"><h2>参加者 ${v.players.length}人</h2><div class="lh-actions"><button class="btn small edit-toggle namebtn" data-do="openRename" aria-label="表示名を変える">${ICON_PENCIL}<span class="nm">${escN(v.me.name, 10)}</span></button></div></div>
    ${rosterHtml()}
    <button class="btn small center" data-do="share">招待リンクを共有する</button>
`;
}
