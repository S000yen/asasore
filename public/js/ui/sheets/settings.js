// 部屋設定（出題者・回答の見せ方・正解を選ぶ人・制限時間、順番）。

import { esc } from '../../lib/format.js';
import { timeSliderHtml } from '../components/parts.js';
import { BETWEEN_ROUNDS } from '../../../../shared/phases.js';

export const settingsSheet = (v) => {
  const s = v.settings, locked = !BETWEEN_ROUNDS.includes(v.phase);
  const seg = (key, opts) => `<div class="seg">${opts.map(([val, label]) => `<button class="btn small ${String(s[key]) === String(val) ? 'on' : ''}" data-do="set" data-key="${key}" data-val="${val}" ${locked ? 'disabled' : ''}>${label}</button>`).join('')}</div>`;
  const ids = s.order.filter((id) => v.players.some((p) => p.id === id && !p.spectator));
  const order = s.presenterMode === 'rotation' ? `<h2>順番（上から）</h2><ul class="order">${ids.map((id, i) => `<li>${esc(v.players.find((p) => p.id === id).name)}<span>
      <button class="btn small" data-do="move" data-id="${esc(id)}" data-dir="-1" ${i === 0 || locked ? 'disabled' : ''} aria-label="上へ">↑</button>
      <button class="btn small" data-do="move" data-id="${esc(id)}" data-dir="1" ${i === ids.length - 1 || locked ? 'disabled' : ''} aria-label="下へ">↓</button></span></li>`).join('')}</ul>` : '';
  return `<h3>部屋設定</h3><div class="stack">
      ${locked ? '<p class="hint">ラウンド中は変更できません</p>' : ''}
      <h2>出題者</h2>${seg('presenterMode', [['host', '主催者'], ['rotation', '順番']])}
      <h2>回答の見せ方</h2>${seg('identityMode', [['named', '記名'], ['anonymous', '匿名']])}
      <h2>正解を選ぶ人</h2>${seg('chooserMode', [['all', '全員'], ['one', '一人']])}
      ${timeSliderHtml(s.timeLimit, 'settings', locked)}
      ${order}</div>`;
};
