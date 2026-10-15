// 反応マークのボタン。

import { isEditing } from '../../core/selectors.js';
import { MARKS } from '../../lib/marks.js';

export function reactBarHtml() {
  const lock = isEditing();
  return `<div class="reactbar">${Object.entries(MARKS).map(([k, m]) => `<button class="react" ${lock ? 'disabled' : `data-do="react" data-kind="${k}"`} aria-label="${{ like: 'いいね', bad: 'バッド', cheer: '応援', laugh: '笑い' }[k]}">${m}</button>`).join('')}</div>`;
}
