// 人を選ぶシート：主催者の譲渡、再入室の許可、選ぶ人・出題者の指名。

import { pickButtons } from './common.js';

export const transferSheet = (v) => {
  const others = v.players.filter((p) => p.id !== v.me.id);
  return `<h3>主催者を譲渡する</h3><div class="menu">${pickButtons('transfer', others.filter((p) => p.connected))}</div>`;
};

export const allowSheet = (v) => {
  return `<h3>再入室を許可する</h3><div class="menu">${pickButtons('allow', v.removed)}</div>`;
};

export const chooserSheet = (v) => {
  return `<h3>選ぶ人を任せる</h3><div class="menu"><button class="btn" data-do="randomChooser">ランダムで指名する</button>${pickButtons('chooser', v.players.filter((p) => p.connected && p.id !== v.chooserId))}</div>`;
};

export const presenterSheet = (v) => {
  return `<h3>出題者を指名する</h3><div class="menu">
      <button class="btn" data-do="randomPresenter">ランダムで指名する</button>
      ${pickButtons('presenter', v.players.filter((p) => p.connected && p.id !== v.presenterId))}</div>`;
};
