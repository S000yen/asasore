// これまでの記録（正解数と得票率のグラフ、ラウンドごとの結果）。

import { esc, escN } from '../../lib/format.js';
import { CHOOSER_MODE } from '../../../../shared/rules.js';

export const historySheet = (v) => {
  const tot = new Map();
  for (const h of v.history) for (const e of h.entries) { const t = tot.get(e.author) ?? { w: 0, v: 0 }; t.w += e.won ? 1 : 0; t.v += e.votes; tot.set(e.author, t); }
  const rank = [...tot].sort((x, y) => y[1].w - x[1].w || y[1].v - x[1].v);
  const maxW = Math.max(1, ...rank.map(([, t]) => t.w));
  const graph = `<div class="graph">${rank.map(([n, t]) => `<div class="g-row${t.w > 0 && t.w === maxW ? ' top' : ''}"><span class="g-name">${escN(n, 10)}</span><span class="g-track"><i style="width:${Math.max(4, (t.w / maxW) * 100)}%"></i></span><span class="g-val">${t.w}<small>正解</small></span></div>`).join('')}</div>`;
  // 得票率：全員の投票で決めたラウンドについて、その人の回答が受けた票 ÷ 投じられた票の合計
  const rate = new Map();
  let rounds = 0;
  for (const h of v.history) {
    if (h.mode === CHOOSER_MODE.ONE || !h.total) continue;
    rounds += 1;
    for (const e of h.entries) { const t = rate.get(e.author) ?? { got: 0, all: 0 }; t.got += e.votes; t.all += h.total; rate.set(e.author, t); }
  }
  const rr = [...rate].map(([n, t]) => [n, t.all ? (t.got / t.all) * 100 : 0]).sort((x, y) => y[1] - x[1]);
  const maxR = Math.max(1, ...rr.map(([, p]) => p));
  const rateGraph = rounds ? `<h3 class="sub">得票率</h3><div class="graph rate">${rr.map(([n, p]) => `<div class="g-row${p > 0 && p === maxR ? ' top' : ''}"><span class="g-name">${escN(n, 10)}</span><span class="g-track"><i style="width:${Math.max(4, (p / maxR) * 100)}%"></i></span><span class="g-val">${Math.round(p)}<small>%</small></span></div>`).join('')}</div>` : '';
  if (!v.history.length) return '<h3>これまでの記録</h3><p class="hint">記録はありません</p>';
  return `<h3>これまでの記録</h3>${graph}${rateGraph}<div class="history">${v.history.map((h) => `
      <article class="rec">
        <div class="rec-head"><span class="rec-no">第${h.round}問</span><span class="rec-topic"><b>${esc(h.topic.hiragana)}</b>で始まる ${esc(h.topic.theme)}</span></div>
        ${h.entries.map((e) => `<div class="rec-row ${e.won ? 'won' : ''}"><span class="rec-text">${esc(e.text)}<small>${escN(e.author, 12)}</small></span><span class="rec-votes">${e.won ? '<i>正解</i>' : ''}${h.mode === CHOOSER_MODE.ONE ? '' : `${e.votes}票`}</span></div>`).join('')}
      </article>`).join('')}</div>`;
};
