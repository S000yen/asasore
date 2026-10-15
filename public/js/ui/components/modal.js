// 確認ダイアログ。

import { ui } from '../../core/state.js';
import { esc } from '../../lib/format.js';

export function modalHtml() {
  const m = ui.modal;
  if (!m) return '';
  return `<div class="scrim dialog" data-do="noop"><div class="sheet"><button class="x" data-do="modalCancel" aria-label="閉じる">×</button>
    ${m.quote ? `<p class="vquote">${esc(m.quote)}</p>` : `<p>${esc(m.body)}</p>`}
    <div class="dialog-actions"><button class="btn ${m.danger ? 'danger' : 'primary'} go" data-do="modalOk">${esc(m.ok)}</button></div>
  </div></div>`;
}
