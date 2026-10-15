// 部屋の中の画面の枠（ヘッダー、フェーズごとの本文、下の操作、シート、ダイアログ）。

import { isEditing } from '../../core/selectors.js';
import { state, ui } from '../../core/state.js';
import { esc } from '../../lib/format.js';
import { actionBar } from '../components/actionBar.js';
import { modalHtml } from '../components/modal.js';
import { toastHtml } from '../components/toast.js';
import { answerHtml } from './answer.js';
import { lobbyHtml } from './lobby.js';
import { resultHtml } from './result.js';
import { revealHtml } from './reveal.js';
import { topicHtml } from './topic.js';
import { voteHtml } from './vote.js';
import { sheetHtml } from '../sheets/index.js';

export function roomHtml() {
  const v = state.view;
  return `
    <header class="bar${isEditing() ? ' locked' : ''}">
      <button class="room" data-do="copyCode" aria-label="部屋番号${esc(v.code)}をコピー"><b class="code">${esc(v.code)}</b></button>
      <div class="round">${v.round ? `第${v.round}問` : ''}</div>
      <div class="bar-right">
        ${'<button class="icon" data-do="sheet" data-kind="history" aria-label="記録"><svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="4" height="14" rx="1"/><rect x="9" y="4" width="4" height="14" rx="1"/><path d="M15.2 5.6l3.6-.9 2.7 12.7-3.6.9z"/><path d="M2 21h20"/></svg></button>'}
        <button class="icon" data-do="openMenu" aria-label="メニュー"><svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 10.5a8.5 6 0 0 1 17 0z"/><path d="M2.5 14h19"/><path d="M4.5 17.5h15v.5a2.5 2.5 0 0 1-2.5 2.5h-10a2.5 2.5 0 0 1-2.5-2.5z"/></svg></button>
      </div>
    </header>
    ${ui.connected ? '' : '<p class="conn">再接続しています。</p>'}
    ${v.phase === 'vote' ? `<div class="phaseband">${v.settings.chooserMode === 'one' ? '選択中' : '投票中'}</div>` : ''}
    <main class="main">${phaseHtml()}</main>
    ${actionBar()}
    ${sheetHtml()}${modalHtml()}${toastHtml()}`;
}

function phaseHtml() {
  switch (state.view.phase) {
    case 'lobby': return lobbyHtml();
    case 'topic': return topicHtml();
    case 'answer': return answerHtml();
    case 'reveal': return revealHtml();
    case 'vote': return voteHtml();
    case 'result': return resultHtml();
    default: return '';
  }
}
