// 部屋で起きたイベント（room.js が返すもの）を、全員に出す通知文にする。
// 通知を出さないイベントは null を返す。名前は room.playerName で引く（いなければ「誰か」）。

export function describe(room, ev) {
  const name = (id) => room.playerName(id) ?? '誰か';
  switch (ev?.type) {
    case 'host_transferred':
      return ev.how === 'auto'
        ? `主催者が不在のため、${name(ev.to)}さんが主催者になりました`
        : `${name(ev.to)}さんが主催者になりました`;
    case 'presenter_changed':
      return `${name(ev.to)}さんが出題者になりました`;
    case 'role_reclaimed':
      return ev.role === 'chooser' ? `主催者が、選ぶ人の役割を戻しました` : `主催者が、出題者の役割を戻しました`;
    case 'chooser_changed':
      return `${name(ev.to)}さんが正解を選ぶ人になりました`;
    case 'spectator_changed':
      return ev.spectator ? `${name(ev.id)}さんが観戦になりました` : `${name(ev.id)}さんが参戦になりました`;
    case 'spectator_pending':
      return null; // 本人にだけ、画面で次のラウンドからと分かる
    case 'time_up':
      return ev.noAnswer ? '時間切れ。回答がなかったので、全員不正解です' : ev.bomb ? '時間切れ。爆弾が爆発しました' : '時間切れ。開示へ進みます';
    case 'room_reset':
      return '主催者が部屋をリセットしました（記録と問題数を消しました）';
    case 'chooser_returned_to_host':
      return `選ぶ人が不在のため、主催者に戻りました`;
    case 'presenter_returned_to_host':
      return `出題者が不在のため、主催者に戻りました`;
    default:
      return null;
  }
}
