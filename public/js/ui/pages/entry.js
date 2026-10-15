// 入室前の画面（部屋をつくる／入る）と、外された・閉じられたときの案内。

import { drafts, newRoom, state, ui } from '../../core/state.js';
import { esc } from '../../lib/format.js';
import { ICON_DOOR, ICON_HAMMER } from '../../lib/icons.js';
import { timeSliderHtml, toastHtml } from '../components/parts.js';

export function entryHtml() {
  if (state.endMessage) return endHtml();
  const resume = state.session ? `<button class="link center" data-do="resume">前の部屋（${esc(state.session.code)}）に戻る</button>` : '';
  const body = ui.joining
    ? '<p class="hint center-text">部屋に入っています…</p>'
    : `<div class="entry-btns">
        <button class="bigbtn primary" data-do="openCreate">${ICON_HAMMER}<span>部屋をつくる</span></button>
        <button class="bigbtn" data-do="openJoin">${ICON_DOOR}<span>部屋に入る</span></button>
      </div>
      ${resume}`;
  const seg = (key, opts) => `<div class="seg">${opts.map(([val, label]) => `<button class="btn small ${newRoom[key] === val ? 'on' : ''}" data-do="newSet" data-key="${key}" data-val="${val}">${label}</button>`).join('')}</div>`;
  const createDialog = ui.createOpen && !ui.joining ? `<div class="scrim dialog" data-do="noop"><div class="sheet"><button class="x" data-do="closeCreate" aria-label="閉じる">×</button>
      <h3>部屋をつくる</h3>
      <div class="stack">
        <h2>出題者</h2>${seg('presenterMode', [['host', '主催者'], ['rotation', '順番']])}
        <h2>回答の見せ方</h2>${seg('identityMode', [['named', '記名'], ['anonymous', '匿名']])}
        <h2>正解を選ぶ人</h2>${seg('chooserMode', [['all', '全員'], ['one', '一人']])}
        ${timeSliderHtml(newRoom.timeLimit, 'create')}
      </div>
      <div class="dialog-actions"><button class="btn primary go" data-do="create">作成</button></div>
    </div></div>` : '';
  const dialog = ui.joinOpen && !ui.joining ? `<div class="scrim dialog" data-do="noop"><div class="sheet"><button class="x" data-do="closeJoin" aria-label="閉じる">×</button>
      <label class="field"><span>部屋コード</span><input id="codeInput" type="text" data-draft="code" maxlength="4" autocapitalize="characters" autocorrect="off" autocomplete="off" spellcheck="false" value="${esc(drafts.code)}"></label>
      <div class="seg join-seg">${[[false, '参戦'], [true, '観戦']].map(([val, label]) => `<button class="btn small ${ui.joinWatch === val ? 'on' : ''}" data-do="setJoinWatch" data-val="${val}">${label}</button>`).join('')}</div>
      <button class="btn primary block" style="margin-top:16px" data-do="join">入る</button>
    </div></div>` : '';
  return `<div class="entry">
    <div class="entry-top">
      <div class="telop hero"><div class="tile">あ</div><h1 class="hero-title">朝からそれ正解</h1></div>
    </div>
    ${body}
    ${ui.connected ? '' : '<p class="hint center-text">サーバーにつなぎ直しています。</p>'}
    <p class="foot-hint">※ シークレットモードなどでの使用は推奨しません</p>
    ${dialog}${createDialog}${toastHtml()}
  </div>`;
}

function endHtml() {
  const e = state.endMessage;
  return `<div class="end">
    <h1 class="title" style="font-size:28px">${esc(e.title)}</h1>
    ${e.body ? `<p class="hint">${esc(e.body)}</p>` : ''}
    ${e.retry && state.session ? '<button class="btn primary center" data-do="resume">もう一度入る</button>' : ''}
    <button class="btn center" data-do="backToEntry">入室画面に戻る</button>
    ${toastHtml()}
  </div>`;
}
