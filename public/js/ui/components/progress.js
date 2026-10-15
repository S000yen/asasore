// 参加者の進み具合（回答済み・投票済み）。

import { chips } from './chips.js';

// 参加者の進み具合（回答済み・投票済み）。枠は付けず、見出しの横に数だけ出す
export const progress = (label, list, done, side = '') => `<div class="progress"><h2><span>${label} ${list.filter(done).length}/${list.length}</span>${side}</h2>${chips(list, done)}</div>`;
