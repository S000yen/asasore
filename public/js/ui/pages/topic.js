// 題決め：出題者は題を直接書き換え、ほかの人は待つ。

import { drafts, state } from '../../core/state.js';
import { bounceHtml } from '../../effects/bounce.js';
import { esc } from '../../lib/format.js';
import { ICON_REDRAW, ICON_TRASH } from '../../lib/icons.js';

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
      <div class="telop-text"><span class="tiny">で始まる</span><textarea id="themeInput" class="theme-edit" rows="1" data-draft="theme" maxlength="40" placeholder="題材" aria-label="題材">${esc(drafts.theme)}</textarea><span class="tiny">といえば？</span></div>
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
