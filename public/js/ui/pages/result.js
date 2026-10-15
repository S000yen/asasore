// 結果発表。

import { state } from '../../core/state.js';
import { esc, escN, sizeOf } from '../../lib/format.js';
import { groupMark } from '../components/pool.js';
import { telop } from '../components/telop.js';

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
      <span class="txt"><span class="text ${won ? 'lg' : sizeOf(t.text)}">${esc(t.text)}</span><span class="by">${escN(t.author, 12)}</span></span>${r.mode === 'one' ? '' : `<span class="vcount">${t.votes}<small>票</small></span>`}</div>`;
  }).join('');
  return `
    ${telop(v.topic)}
    ${r.tie ? '<p class="hint">同票：どれも正解</p>' : ''}
    ${r.noAnswer || r.winners.length === 0 ? `<div class="allwrong"><b>全員不正解！</b><span>${r.noAnswer ? '回答がありませんでした' : '投票がありませんでした'}</span></div>` : ''}
    ${rows ? `<section class="pool">${rows}</section>` : ''}`;
}
