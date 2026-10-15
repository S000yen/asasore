// 開示：回答を1つずつ開く。

import { isEditing } from '../../core/selectors.js';
import { state } from '../../core/state.js';
import { groupBarHtml, groupToggleHtml, poolHtml } from '../components/pool.js';
import { reactBarHtml } from '../components/reactBar.js';
import { telop } from '../components/telop.js';

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
