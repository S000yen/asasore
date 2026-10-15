// 投票：正解だと思う回答を選ぶ。

import { state } from '../../core/state.js';
import { groupBarHtml, groupToggleHtml, poolHtml } from '../components/pool.js';
import { progress } from '../components/progress.js';
import { telop } from '../components/telop.js';

export function voteHtml() {
  const v = state.view, one = v.settings.chooserMode === 'one';
  return `
    ${telop(v.topic)}
    <div class="listhead"><h2>${one ? (v.me.isChooser ? '正解を選んでください' : '正解を選んでいます') : '正解だと思う回答に投票'}</h2>${groupToggleHtml()}</div>
    ${poolHtml()}${groupBarHtml()}
    ${one ? '' : progress('投票状況', v.players.filter((p) => !p.spectator), (p) => p.voted)}`;
}
