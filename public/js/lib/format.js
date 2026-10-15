// 画面の文字列を整える小さな関数：HTML の特殊文字の置き換え、長い名前の省略、回答の長さによる文字の大きさ。

// 長い名前は、真ん中を「…」にして、最後の少し（同名のときの番号など）を残す
const short = (name, max = 12) => {
  const cs = [...String(name ?? '')];
  if (cs.length <= max) return cs.join('');
  const tail = 3;
  return `${cs.slice(0, max - tail - 1).join('')}…${cs.slice(-tail).join('')}`;
};
export const escN = (name, max) => esc(short(name, max));
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// 回答の長さで文字の大きさを変える（短い答えは大きく、長い答えは小さく）
export const sizeOf = (text) => { const n = [...String(text)].length; return n <= 8 ? 'lg' : n <= 22 ? 'md' : 'sm'; };
