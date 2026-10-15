// 部屋で起きたイベント（room.js が返すもの）を、全員に出す通知文にする。
// 通知を出さないイベントは null を返す。名前は room.playerName で引く（いなければ「誰か」）。

import { EVENT } from './events.js';

const nameOf = (room, id) => room.playerName(id) ?? '誰か';

// イベント種別ごとの通知文。通知を出さない種別も、() => null と書いて、決めたことを残す。
// （全ての種別が書いてあることは、テストで確かめている）
export const NOTICES = {
  [EVENT.HOST_TRANSFERRED]: (room, ev) => (ev.how === 'auto'
    ? `主催者が不在のため、${nameOf(room, ev.to)}さんが主催者になりました`
    : `${nameOf(room, ev.to)}さんが主催者になりました`),
  [EVENT.PRESENTER_CHANGED]: (room, ev) => `${nameOf(room, ev.to)}さんが出題者になりました`,
  [EVENT.ROLE_RECLAIMED]: (room, ev) => (ev.role === 'chooser' ? `主催者が、選ぶ人の役割を戻しました` : `主催者が、出題者の役割を戻しました`),
  [EVENT.CHOOSER_CHANGED]: (room, ev) => `${nameOf(room, ev.to)}さんが正解を選ぶ人になりました`,
  [EVENT.SPECTATOR_CHANGED]: (room, ev) => (ev.spectator ? `${nameOf(room, ev.id)}さんが観戦になりました` : `${nameOf(room, ev.id)}さんが参戦になりました`),
  [EVENT.TIME_UP]: (room, ev) => (ev.noAnswer ? '時間切れ。回答がなかったので、全員不正解です' : ev.bomb ? '時間切れ。爆弾が爆発しました' : '時間切れ。開示へ進みます'),
  [EVENT.ROOM_RESET]: () => '主催者が部屋をリセットしました（記録と問題数を消しました）',
  [EVENT.CHOOSER_RETURNED_TO_HOST]: () => `選ぶ人が不在のため、主催者に戻りました`,
  [EVENT.PRESENTER_RETURNED_TO_HOST]: () => `出題者が不在のため、主催者に戻りました`,

  // 通知を出さない
  [EVENT.SPECTATOR_PENDING]: () => null, // 本人にだけ、画面で次のラウンドからと分かる
  [EVENT.RENAMED]: () => null,
  [EVENT.PLAYER_REMOVED]: () => null,
  [EVENT.PLAYER_ALLOWED]: () => null,
  [EVENT.SETTINGS_CHANGED]: () => null,
  [EVENT.ROUND_STARTED]: () => null,
  [EVENT.TOPIC_DRAFT]: () => null,
  [EVENT.TOPIC_CONFIRMED]: () => null,
  [EVENT.TOPIC_REPORTED]: () => null,
  [EVENT.ROOM_CLOSED]: () => null,
  [EVENT.REACT]: () => null,
};

export function describe(room, ev) {
  const make = ev && Object.hasOwn(NOTICES, ev.type) ? NOTICES[ev.type] : null; // 知らない種別は、通知なし
  return make ? make(room, ev) : null;
}
