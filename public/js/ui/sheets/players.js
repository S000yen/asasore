// 参加者一覧（主催者は、タップして外せる）。

import { esc } from '../../lib/format.js';
import { badgeHost, badgeSpec } from '../../lib/icons.js';

export const playersSheet = (v) => {
  const host = v.me.isHost;
  // 全員が見られる。外せるのは主催者だけ（自分自身はタップしても何も起きない）
  const row = (p) => {
    const me = p.id === v.me.id;
    const inner = `${p.isHost ? badgeHost : ''}${p.spectator ? badgeSpec : ''}<span class="pname">${esc(p.name)}</span>${me ? '<span class="tag">あなた</span>' : ''}${p.connected === false ? '<span class="tag">離席中</span>' : ''}`;
    return host && !me
      ? `<button class="btn prow" data-do="pick" data-kind="remove" data-id="${esc(p.id)}">${inner}</button>`
      : `<div class="prow${me ? ' me' : ''}">${inner}</div>`;
  };
  return `<h3>参加者一覧</h3><div class="plist">${v.players.map(row).join('')}</div>`;
};
