// 遊び方（howto.md）の、簡単な変換：見出しと箇条書きと太字だけ。

import { esc } from './format.js';

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
