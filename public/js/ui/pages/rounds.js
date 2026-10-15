// ラウンドの各フェーズの画面：題決め、回答、開示、投票、結果発表。

import { drafts, isEditing, state } from '../../core/state.js';
import { bounceHtml } from '../../effects/ambient.js';
import { esc, escN, sizeOf } from '../../lib/format.js';
import { ICON_REDRAW, ICON_TRASH } from '../../lib/icons.js';
import { progress, reactBarHtml, telop, timerHtml } from '../components/parts.js';
import { groupBarHtml, groupMark, groupToggleHtml, poolHtml } from '../components/pool.js';
import { MAX_ANSWER_LEN, MAX_THEME_LEN, CHOOSER_MODE } from '../../../../shared/rules.js';

export function topicHtml() {
  const v = state.view;
  if (!v.me.isPresenter) {
    return bounceHtml();
  }
  // テロップそのものが入力欄（頭文字と題材を、直接書き換える）
  const rbtn = (part, label, cls = '') => `<button class="rbtn ${cls}" data-do="draw" data-part="${part}" aria-label="${label}を引き直す">${ICON_REDRAW}<small>${label}</small></button>`;
  return `
    <div class="telop edit">
      <div class="tile"><input id="hiraInput" class="tile-input" type="text" data-draft="hiragana" maxlength="1" placeholder="？" aria-label="頭文字" autocomplete="off" value="${esc(drafts.hiragana)}"></div>
      <div class="telop-text"><span class="tiny">で始まる</span><textarea id="themeInput" class="theme-edit" rows="1" data-draft="theme" maxlength="${MAX_THEME_LEN}" placeholder="題材" aria-label="題材">${esc(drafts.theme)}</textarea><span class="tiny">といえば？</span></div>
    </div>
    <div class="redraw-row">
      <div class="redraws">
        <div class="rgroup">${rbtn('hiragana', '頭文字')}${rbtn('theme', '題材')}</div>
        ${rbtn('both', '両方')}
      </div>
      <button class="rbtn trash" data-do="reportTopic" aria-label="この題材を報告して引き直す">${ICON_TRASH}<small>報告</small></button>
    </div>
`;
}

export function answerHtml() {
  const v = state.view;
  const box = v.me.spectator ? '' : `
    <div class="answerbox">
      <textarea id="answerInput" data-draft="answer" rows="3" maxlength="${MAX_ANSWER_LEN}" placeholder="答えを入力" ${v.myAnswer !== null ? 'readonly' : ''}>${esc(drafts.answer)}</textarea>
      <div class="box-actions">${v.myAnswer !== null ? '<button class="btn small" data-do="withdraw">取り下げる</button>' : '<button class="btn primary small" data-do="submitAnswer">回答する</button>'}</div>
    </div>`;
  return `
    ${telop(v.topic)}${box}
    ${progress('回答状況', v.players.filter((p) => !p.spectator), (p) => p.answered, timerHtml())}`;
}

export function revealHtml() {
  const v = state.view, host = v.me.isHost;
  const total = v.pool.length;
  return `
    ${telop(v.topic)}
    <div class="listhead"><h2>開示済み ${total - v.unrevealedCount}/${total}</h2><span class="lh-actions">${host && v.unrevealedCount > 0 && !isEditing() ? '<button class="btn small" data-do="revealAll">残りを全員分開示</button>' : ''}${groupToggleHtml()}</span></div>
    ${poolHtml()}${groupBarHtml()}
    ${reactBarHtml()}
`;
}

export function voteHtml() {
  const v = state.view, one = v.settings.chooserMode === CHOOSER_MODE.ONE;
  return `
    ${telop(v.topic)}
    <div class="listhead"><h2>${one ? (v.me.isChooser ? '正解を選んでください' : '正解を選んでいます') : '正解だと思う回答に投票'}</h2>${groupToggleHtml()}</div>
    ${poolHtml()}${groupBarHtml()}
    ${one ? '' : progress('投票状況', v.players.filter((p) => !p.spectator), (p) => p.voted)}`;
}

export function resultHtml() {
  const v = state.view, r = v.result;
  if (!r) return '<p class="hint">結果を集計しています。</p>';
  const winners = new Set(r.winners);
  const rows = [...r.tallies].sort((a, b) => b.votes - a.votes).map((t) => {
    const won = winners.has(t.answerId);
    const wide = won || [...t.text].length > 10 ? ' wide' : '';
    return `<div class="cell ${won ? 'win' : 'open'}${wide}">
      ${t.group ? `<span class="gtag in" aria-label="同じ回答 ${groupMark(t.group)}">${groupMark(t.group)}</span>` : ''}
      ${won ? '<span class="stamp">正解</span>' : ''}
      <span class="txt"><span class="text ${won ? 'lg' : sizeOf(t.text)}">${esc(t.text)}</span><span class="by">${escN(t.author, 12)}</span></span>${r.mode === CHOOSER_MODE.ONE ? '' : `<span class="vcount">${t.votes}<small>票</small></span>`}</div>`;
  }).join('');
  return `
    ${telop(v.topic)}
    ${r.tie ? '<p class="hint">同票：どれも正解</p>' : ''}
    ${r.noAnswer || r.winners.length === 0 ? `<div class="allwrong"><b>全員不正解！</b><span>${r.noAnswer ? '回答がありませんでした' : '投票がありませんでした'}</span></div>` : ''}
    ${rows ? `<section class="pool">${rows}</section>` : ''}`;
}
