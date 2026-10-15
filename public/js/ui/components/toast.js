// 画面の上に出る、短い通知。

import { ui } from '../../core/state.js';
import { esc } from '../../lib/format.js';

export const toastHtml = () => (ui.toast ? `<div class="toast" role="status">${esc(ui.toast)}</div>` : '');
