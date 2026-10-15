// 回答の制限時間のバー。

// 回答の制限時間：5〜180秒のバー。いちばん右が「なし」。目盛りをタップすると、その時間になる。
const TS_MIN = 5, TS_MAX = 180, TS_NONE = TS_MAX + 25; // 右端の「なし」は、180秒の目盛りと重ならないよう、少し離しておく
const TS_TICKS = [5, 30, 60, 90, 120, 150, 180, 0];
const tsPos = (v) => (Number(v) === 0 ? TS_NONE : Number(v));
export const tsLabel = (v) => (Number(v) === 0 ? 'なし' : `${v}秒`);
export function timeSliderHtml(value, ctx, disabled = false) {
  const frac = (pos) => (pos - TS_MIN) / (TS_NONE - TS_MIN);
  const ticks = TS_TICKS.map((v) => `<button type="button" class="tick${Number(value) === v ? ' on' : ''}" style="--f:${frac(tsPos(v))}" data-do="setTime" data-ctx="${ctx}" data-val="${v}" ${disabled ? 'disabled' : ''}>${v === 0 ? 'なし' : v}</button>`).join('');
  return `<div class="tslider" data-ctx="${ctx}">
    <div class="thead"><h2>回答の制限時間</h2><span class="tval">${tsLabel(value)}</span></div>
    <input type="range" class="trange" min="${TS_MIN}" max="${TS_NONE}" step="5" value="${tsPos(value)}" data-slider="${ctx}" style="--f:${frac(tsPos(value))}" aria-label="回答の制限時間" ${disabled ? 'disabled' : ''}>
    <div class="ticks">${ticks}</div>
  </div>`;
}

// つまみの値。いちばん右の「なし」は、制限時間 0 に戻す。
export const sliderVal = (el) => { const n = Number(el.value); return n > TS_MAX ? 0 : n; };
