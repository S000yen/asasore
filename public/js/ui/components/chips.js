// 参加者の名前の並び。

import { state } from '../../core/state.js';
import { escN } from '../../lib/format.js';
import { badgeHost } from '../../lib/icons.js';

export const chips = (list, mark) => `<div class="chips">${list.map((p) =>
  `<span class="chip ${p.connected ? '' : 'away'}${p.id === state.view?.me.id ? ' me' : ''}">${p.isHost ? badgeHost : ''}${escN(p.name, 12)}${mark && mark(p) ? '<span class="mark">✓</span>' : ''}${p.connected ? '' : '<span class="tag">離席中</span>'}</span>`).join('')}</div>`;
