// 表示名の変更。

import { drafts } from '../../core/state.js';
import { esc } from '../../lib/format.js';

export const renameSheet = (v) => {
  return `<h3>表示名を変える</h3><div class="stack">
      <label class="field"><span>表示名</span><input id="renameInput" type="text" data-draft="rename" maxlength="200" autocomplete="off" value="${esc(drafts.rename)}"></label>
      <button class="btn primary block" data-do="doRename">変更する</button></div>`;
};
