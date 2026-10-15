// 部屋への操作（クライアントの act メッセージ）を、room / topics の呼び出しに振り分ける。
// 通信は持たない。結果の形だけを返し、配信は呼び出し側（index.js）が行う。
//
// handleAct(ctx, pid, msg) の ctx は { room, topics, clientId }。clientId は端末ごとの匿名ID（無ければ null）。
// 戻り値：
//   { ev }                  通常。ev は通知に使うイベント（無ければ undefined）
//   { needConfirm: r }      未完了の人がいるので、確認を求める（advance）
//   { react }               反応マーク。状態は変えず、全員に流すだけ
//   { leave: true }         この人の退出
//   { closed: true }        部屋を閉じた

import { RoomError } from './roles.js';

const DRAW_PARTS = ['hiragana', 'theme', 'both'];

// 通常の操作。ブロックで書いたものは、イベントを通知に使わない。式で書いたものは、room が返したイベントを通知に使う。
const ACTIONS = {
  setSettings: ({ room }, pid, msg) => { room.setSettings(pid, msg.patch); },
  setTopic: ({ room }, pid, msg) => { room.setTopic(pid, { hiragana: msg.hiragana, theme: msg.theme }); },
  // part: 'hiragana' | 'theme' | 'both'。手入力中の内容があれば、引き直さない側はそれを残す
  drawTopic: ({ room, topics }, pid, msg) => {
    if (!DRAW_PARTS.includes(msg.part)) throw new RoomError('bad_request', '引き直しの指定が正しくありません');
    const current = {
      hiragana: String(msg.hiragana ?? '').trim() || room.topic?.hiragana,
      theme: String(msg.theme ?? '').trim() || room.topic?.theme,
    };
    room.setTopic(pid, topics.draw(current, msg.part, room.drawFilter()));
  },
  // 選択中のお題を「おかしい」と報告する。この部屋では二度と出さず、全体の出現率も下げ、題材を引き直す
  reportTopic: ({ room, topics, clientId }, pid, msg) => {
    const theme = String(msg.theme ?? '');
    room.reportTopic(pid, theme);
    topics.flag(theme, clientId ?? pid);
    room.setTopic(pid, topics.draw(room.topic, 'theme', room.drawFilter()));
  },
  // 手入力の内容が付いていれば、先にそれを反映してから確定する（失敗したらここで止まる）
  confirmTopic: ({ room, topics }, pid, msg) => {
    if (msg.hiragana !== undefined || msg.theme !== undefined) {
      room.setTopic(pid, { hiragana: msg.hiragana, theme: msg.theme });
    }
    room.confirmTopic(pid);
    topics.register(room.topic); // 手動で入れた未登録の題材・組み合わせはここで登録される
  },
  setPresenter: ({ room }, pid, msg) => room.setPresenter(pid, msg.to),
  randomPresenter: ({ room }, pid) => room.randomPresenter(pid),
  submitAnswer: ({ room }, pid, msg) => { room.submitAnswer(pid, msg.text); },
  withdrawAnswer: ({ room }, pid) => { room.withdrawAnswer(pid); },
  revealOwn: ({ room }, pid) => { room.revealOwn(pid); },
  revealSelected: ({ room }, pid, msg) => { room.revealSelected(pid, msg.answerId); },
  revealAll: ({ room }, pid) => { room.revealAll(pid); },
  vote: ({ room }, pid, msg) => { room.vote(pid, msg.answerId); },
  choose: ({ room }, pid, msg) => { room.choose(pid, msg.answerId); },
  setSpectator: ({ room }, pid, msg) => room.setSpectator(pid, msg.spectator),
  resetRoom: ({ room }, pid) => room.resetRoom(pid),
  group: ({ room }, pid, msg) => { room.group(pid, msg.answerIds); },
  ungroup: ({ room }, pid, msg) => { room.ungroup(pid, msg.answerIds); },
  reclaimRole: ({ room }, pid) => room.reclaimRole(pid),
  randomChooser: ({ room }, pid) => room.randomChooser(pid),
  setChooser: ({ room }, pid, msg) => room.setChooser(pid, msg.to),
  rename: ({ room }, pid, msg) => { room.rename(pid, msg.name); },
  transferHost: ({ room }, pid, msg) => room.transferHost(pid, msg.to),
  removePlayer: ({ room }, pid, msg) => { room.removePlayer(pid, msg.to); },
  allowRejoin: ({ room }, pid, msg) => { room.allowRejoin(pid, msg.to); },
};

// 戻り値の形が通常と違う操作（結果の形をそのまま返す）
const SPECIAL = {
  advance: ({ room }, pid, msg) => {
    const r = room.advance(pid, { force: Boolean(msg.force) });
    return r.needConfirm ? { needConfirm: r } : { ev: undefined };
  },
  react: ({ room }, pid, msg) => ({ react: room.react(pid, msg.kind) }),
  leave: ({ room }, pid) => {
    room.leave(pid);
    return { leave: true };
  },
  closeRoom: ({ room }, pid) => {
    room.close(pid);
    return { closed: true };
  },
};

export function handleAct(ctx, pid, msg) {
  const name = msg.a;
  if (Object.hasOwn(SPECIAL, name)) return SPECIAL[name](ctx, pid, msg);
  if (Object.hasOwn(ACTIONS, name)) return { ev: ACTIONS[name](ctx, pid, msg) };
  throw new RoomError('bad_request', '不明な操作です');
}
