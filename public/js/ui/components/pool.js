// 回答のプール（マスの並び）と、同じ回答をまとめる操作。

import { canEditGroups, isEditing, state, ui } from '../../core/state.js';
import { esc, escN, sizeOf } from '../../lib/format.js';
import { IDENTITY_MODE } from '../../../../shared/rules.js';

// 回答のプール：全部の回答が、位置を変えずに並ぶ。未開示は黒マス、開示されたものだけ中身が見える。
// 主催者が「同じ回答」としてまとめたものには、同じ記号（A、B…）の札が付く。チェックは、まとめる／ばらす対象の選択。
export const groupMark = (n) => String.fromCharCode(64 + n);
export function poolHtml() {
  const v = state.view, anon = v.settings.identityMode === IDENTITY_MODE.ANONYMOUS;
  const editing = isEditing();
  const myGroup = v.myVote ? v.pool.find((x) => x.answerId === v.myVote)?.group ?? null : null;
  const cells = v.pool.map((c) => {
    const me = c.mine ? ' mine' : '';
    if (!c.revealed) {
      const cls = `cell dark${me}`;
      const inner = c.canReveal && !editing
        ? `<button class="${cls} tap" aria-label="開示" data-do="${anon ? 'revealSelected' : 'revealOwn'}" data-id="${esc(c.answerId)}"></button>`
        : `<div class="${cls}"></div>`;
      return `<div class="cw">${inner}</div>`;
    }
    const wide = [...c.text].length > 10 ? ' wide' : '';
    const picked = v.myVote === c.answerId || (myGroup !== null && c.group === myGroup);
    const body = `<span class="txt"><span class="text ${sizeOf(c.text)}">${esc(c.text)}</span>${c.author ? `<span class="by">${escN(c.author, 12)}</span>` : ''}</span>`;
    const cls = `cell open${me}${picked ? ' picked' : ''}`;
    const main = c.canVote && !editing
      ? `<button class="${cls}" data-do="vote" data-id="${esc(c.answerId)}">${body}</button>`
      : `<div class="${cls}">${body}</div>`;
    const on = ui.sel.has(c.answerId);
    const check = c.canGroup && editing ? `<button class="chk${on ? ' on' : ''}" role="checkbox" aria-checked="${on}" aria-label="まとめる対象に選ぶ" data-do="toggleSel" data-id="${esc(c.answerId)}"></button>` : '';
    const tag = c.group ? `<span class="gtag" aria-label="同じ回答 ${groupMark(c.group)}">${groupMark(c.group)}</span>` : '';
    return `<div class="cw${wide}${editing ? ' sel' : ''}">${main}${check}${tag}</div>`;
  }).join('');
  return `<section class="pool">${cells}</section>`;
}

// 主催者だけの、同じ回答をまとめる操作。見出しの右の同じボタンで、編集のオン／オフを切り替える。編集中は、ほかの操作はできない。
export function groupToggleHtml() {
  if (!canEditGroups()) return '';
  const on = isEditing();
  return `<button class="btn small edit-toggle${on ? ' on' : ''}" data-do="${on ? 'editDone' : 'editOn'}">${on ? '編集を完了' : 'まとめを編集'}</button>`;
}

// 編集中だけ、プールの下に出る「まとめる」「ばらす」
export function groupBarHtml() {
  const v = state.view;
  if (!isEditing()) return '';
  const picked = v.pool.filter((c) => ui.sel.has(c.answerId));
  const canGroup = picked.length >= 2;
  const canUngroup = picked.some((c) => c.group);
  return `<div class="groupbar"><span class="gcount">${picked.length ? `${picked.length}件を選択中` : ''}</span>
    <button class="btn small" data-do="groupSel" ${canGroup ? '' : 'disabled'}>まとめる</button>
    <button class="btn small" data-do="ungroupSel" ${canUngroup ? '' : 'disabled'}>ばらす</button></div>`;
}
