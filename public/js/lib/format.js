// 画面の文字列を整える小さな関数：HTML の特殊文字の置き換え、長い名前の省略、回答の長さによる文字の大きさ、
// 遊び方（howto.md）の簡単な変換（見出しと箇条書きと太字だけ）。

// 長い名前は、真ん中を「…」にして、最後の少し（同名のときの番号など）を残す
const short = (name, max) => {
  const cs = [...String(name ?? '')];
  if (cs.length <= max) return cs.join('');
  const tail = 3;
  return `${cs.slice(0, max - tail - 1).join('')}…${cs.slice(-tail).join('')}`;
};
export const escN = (name, max) => esc(short(name, max));
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// 回答の長さで文字の大きさを変える（短い答えは大きく、長い答えは小さく）
export const sizeOf = (text) => { const n = [...String(text)].length; return n <= 8 ? 'lg' : n <= 22 ? 'md' : 'sm'; };

export function mdToHtml(md) {
  const inline = (t) => esc(t).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  const out = [];
  let list = null;
  const close = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const raw of md.split('\n')) {
    const line = raw.trimEnd();
    let m;
    if ((m = line.match(/^(#{1,3})\s+(.*)$/))) { close(); out.push(m[1].length === 1 ? '' : `<h2>${inline(m[2])}</h2>`); }
    else if ((m = line.match(/^\d+\.\s+(.*)$/))) { if (list !== 'ol') { close(); out.push('<ol>'); list = 'ol'; } out.push(`<li>${inline(m[1])}</li>`); }
    else if ((m = line.match(/^-\s+(.*)$/))) { if (list !== 'ul') { close(); out.push('<ul>'); list = 'ul'; } out.push(`<li>${inline(m[1])}</li>`); }
    else if (line === '') close();
    else { close(); out.push(`<p>${inline(line)}</p>`); }
  }
  close();
  return out.join('');
}
