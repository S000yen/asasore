// シートで共通の部品。

import { esc, escN } from '../../lib/format.js';

// 人を選ぶボタンの並び。対象がいなければ、その旨を出す。
export const pickButtons = (kind, list) => list.map((p) => `<button class="btn" data-do="pick" data-kind="${kind}" data-id="${esc(p.id)}">${escN(p.name, 24)}${p.spectator ? '（観戦中）' : ''}${p.connected === false ? '（離席中）' : ''}</button>`).join('') || '<p class="hint">対象の人がいません。</p>';
