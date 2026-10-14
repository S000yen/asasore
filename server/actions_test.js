import test from 'node:test';
import assert from 'node:assert/strict';
import { handleAct } from './actions.js';
import { Room } from './room.js';
import { TopicPool } from './topics.js';

// n人入室した部屋。ids[0] が主催者。run(i, msg) で、i 番目の人としてアクションを送る。
function setup(n = 3) {
  const room = new Room('TEST');
  const topics = new TopicPool(['A', 'B', 'C']);
  const ids = [];
  for (let i = 0; i < n; i++) ids.push(room.join(null, `P${i}`, 1000 + i).id);
  const run = (i, msg, clientId = null) => handleAct({ room, topics, clientId }, ids[i], msg);
  return { room, topics, ids, run };
}

// 題決めの段階まで進める（出題者は主催者）
function toTopic(s) {
  s.run(0, { a: 'advance' });
  assert.equal(s.room.phase, 'topic');
}

const code = (fn) => (e) => { assert.equal(e.code, fn); return true; };

test('不明な操作は bad_request（Object のメソッド名や、操作名なしも）', () => {
  const s = setup();
  for (const a of ['nope', 'constructor', 'toString', '__proto__', 'hasOwnProperty', '', undefined, 42]) {
    assert.throws(() => s.run(0, { a }), code('bad_request'), String(a));
  }
});

test('通常の操作は { ev } を返し、イベントを通知に使うのは決まった操作だけ', () => {
  const s = setup();
  // 設定の変更や名前の変更は、room がイベントを返しても通知には使わない
  assert.deepEqual(s.run(0, { a: 'setSettings', patch: { identityMode: 'anonymous' } }), { ev: undefined });
  assert.deepEqual(s.run(1, { a: 'rename', name: '新しい名前' }), { ev: undefined });
  assert.equal(s.room.settings.identityMode, 'anonymous');
  assert.equal(s.room.players.get(s.ids[1]).name, '新しい名前');
  // 観戦の切り替え・主催者の譲渡は、イベントを返す
  assert.equal(s.run(1, { a: 'setSpectator', spectator: true }).ev.type, 'spectator_changed');
  assert.equal(s.run(0, { a: 'transferHost', to: s.ids[2] }).ev.type, 'host_transferred');
  assert.equal(s.room.hostId, s.ids[2]);
});

test('イベントを返す操作：出題者の指名（任せる・ランダム）', () => {
  const s = setup();
  toTopic(s);
  assert.equal(s.run(0, { a: 'setPresenter', to: s.ids[1] }).ev.type, 'presenter_changed');
  assert.equal(s.room.presenterId, s.ids[1]);
  // 指名できるのは、いまの出題者（ここでは 1 番目の人）
  assert.throws(() => s.run(0, { a: 'randomPresenter' }), code('not_allowed'));
  assert.equal(s.run(1, { a: 'randomPresenter' }).ev.type, 'presenter_changed');
});

test('回収するものがなければ、エラー', () => {
  const s = setup();
  toTopic(s); // 出題者は主催者のまま
  assert.throws(() => s.run(0, { a: 'reclaimRole' }), code('nothing_to_reclaim'));
});

test('主催者に戻す：出題者を渡したあと、回収できる', () => {
  const s = setup();
  toTopic(s);
  s.run(0, { a: 'setPresenter', to: s.ids[1] });
  const out = s.run(0, { a: 'reclaimRole' });
  assert.equal(out.ev.type, 'role_reclaimed');
  assert.equal(s.room.presenterId, s.ids[0]);
});

test('リセットはイベントを返す', () => {
  const s = setup();
  toTopic(s);
  assert.equal(s.run(0, { a: 'resetRoom' }).ev.type, 'room_reset');
  assert.equal(s.room.phase, 'lobby');
});

test('部屋の権限エラーは、そのまま RoomError で上がる', () => {
  const s = setup();
  assert.throws(() => s.run(1, { a: 'advance' }), code('not_host'));
  assert.throws(() => s.run(1, { a: 'setSettings', patch: {} }), code('not_host'));
  assert.throws(() => s.run(1, { a: 'closeRoom' }), code('not_host'));
  assert.throws(() => s.run(0, { a: 'removePlayer', to: s.ids[0] }), code('bad_target'));
});

test('advance：未完了の人がいると確認を返し、force で進む', () => {
  const s = setup();
  toTopic(s);
  s.run(0, { a: 'setTopic', hiragana: 'あ', theme: 'A' });
  s.run(0, { a: 'confirmTopic' });
  assert.equal(s.room.phase, 'answer');
  s.run(0, { a: 'submitAnswer', text: 'こたえ' });
  const ask = s.run(0, { a: 'advance' });
  assert.equal(ask.needConfirm.needConfirm, true);
  assert.equal(ask.needConfirm.pending.count, 2);
  assert.equal(ask.needConfirm.phase, 'answer');
  assert.equal(s.room.phase, 'answer'); // 確認を返しただけで、進んでいない
  assert.deepEqual(s.run(0, { a: 'advance', force: true }), { ev: undefined });
  assert.equal(s.room.phase, 'reveal');
});

test('advance：題が未確定のときは進めない', () => {
  const s = setup();
  toTopic(s);
  assert.throws(() => s.run(0, { a: 'advance' }), code('topic_not_confirmed'));
});

test('react：反応を返す（連打は null）。状態は変えない', () => {
  const s = setup();
  toTopic(s);
  s.run(0, { a: 'setTopic', hiragana: 'あ', theme: 'A' });
  s.run(0, { a: 'confirmTopic' });
  for (let i = 0; i < 3; i++) s.run(i, { a: 'submitAnswer', text: `こたえ${i}` });
  s.run(0, { a: 'advance' });
  assert.equal(s.room.phase, 'reveal');
  const first = s.run(1, { a: 'react', kind: 'like' });
  assert.deepEqual(first, { react: { type: 'react', kind: 'like' } });
  assert.deepEqual(s.run(1, { a: 'react', kind: 'like' }), { react: null }); // 0.12秒以内の連打
  assert.throws(() => s.run(2, { a: 'react', kind: 'unknown' }), code('bad_reaction'));
});

test('leave：主催者は、ほかに人がいるうちは退出できない。一般参加者は { leave: true }', () => {
  const s = setup();
  assert.throws(() => s.run(0, { a: 'leave' }), code('transfer_first'));
  assert.deepEqual(s.run(1, { a: 'leave' }), { leave: true });
  assert.equal(s.room.players.get(s.ids[1]).connected, false);
});

test('closeRoom：主催者なら { closed: true } で、部屋が閉じる', () => {
  const s = setup();
  assert.deepEqual(s.run(0, { a: 'closeRoom' }), { closed: true });
  assert.equal(s.room.closed, true);
});

// ---------- お題 ----------

test('drawTopic：引き直しの指定が正しくなければ bad_request', () => {
  const s = setup();
  toTopic(s);
  assert.throws(() => s.run(0, { a: 'drawTopic', part: 'nothing' }), code('bad_request'));
  assert.throws(() => s.run(0, { a: 'drawTopic' }), code('bad_request'));
});

test('drawTopic：両方を引くと、お題が決まる（まだ確定はしない）', () => {
  const s = setup();
  toTopic(s);
  s.run(0, { a: 'drawTopic', part: 'both' });
  assert.match(s.room.topic.hiragana, /^[ぁ-ん]$/);
  assert.ok(['A', 'B', 'C'].includes(s.room.topic.theme));
  assert.equal(s.room.topicConfirmed, false);
});

test('drawTopic：頭文字だけ引き直すと、手入力の題材は残る', () => {
  const s = setup();
  toTopic(s);
  for (let i = 0; i < 20; i++) {
    s.run(0, { a: 'drawTopic', part: 'hiragana', hiragana: 'う', theme: 'B' });
    assert.equal(s.room.topic.theme, 'B');
    assert.notEqual(s.room.topic.hiragana, 'う'); // 引き直すので、いまの文字とは違うものになる
  }
});

test('drawTopic：題材だけ引き直すと、手入力の頭文字は残る', () => {
  const s = setup();
  toTopic(s);
  for (let i = 0; i < 20; i++) {
    s.run(0, { a: 'drawTopic', part: 'theme', hiragana: 'う', theme: 'A' });
    assert.equal(s.room.topic.hiragana, 'う');
    assert.notEqual(s.room.topic.theme, 'A');
  }
});

test('drawTopic：入力が空なら、いまのお題の側を残す', () => {
  const s = setup();
  toTopic(s);
  s.run(0, { a: 'setTopic', hiragana: 'か', theme: 'C' });
  s.run(0, { a: 'drawTopic', part: 'theme', hiragana: '', theme: '' });
  assert.equal(s.room.topic.hiragana, 'か');
});

test('drawTopic：出題者でなければ、引き直せない', () => {
  const s = setup();
  toTopic(s);
  assert.throws(() => s.run(1, { a: 'drawTopic', part: 'both' }), code('not_presenter'));
});

test('reportTopic：その部屋では二度と出さず、報告は端末ごとに数え、題材を引き直す', () => {
  const s = setup();
  toTopic(s);
  s.run(0, { a: 'setTopic', hiragana: 'あ', theme: 'A' });
  s.run(0, { a: 'reportTopic', theme: 'A' }, 'client-abcdef12');
  assert.ok(s.room.blockedThemes.has('A'));
  assert.notEqual(s.room.topic.theme, 'A'); // 引き直された
  assert.equal(s.room.topic.hiragana, 'あ'); // 頭文字はそのまま
  assert.ok(s.topics.themes.get('A').flaggers.has('client-abcdef12'));
});

test('reportTopic：端末IDがなければ、参加者のIDで数える', () => {
  const s = setup();
  toTopic(s);
  s.run(0, { a: 'setTopic', hiragana: 'あ', theme: 'B' });
  s.run(0, { a: 'reportTopic', theme: 'B' }, null);
  assert.ok(s.topics.themes.get('B').flaggers.has(s.ids[0]));
});

test('reportTopic：お題が変わっていたら失敗し、報告も数えない', () => {
  const s = setup();
  toTopic(s);
  s.run(0, { a: 'setTopic', hiragana: 'あ', theme: 'A' });
  assert.throws(() => s.run(0, { a: 'reportTopic', theme: 'B' }, 'client-abcdef12'), code('bad_topic'));
  assert.equal(s.topics.themes.get('B').flaggers.size, 0);
  assert.equal(s.room.topic.theme, 'A');
  assert.equal(s.room.blockedThemes.size, 0);
});

test('confirmTopic：手入力の内容を反映して確定し、新しい題材はお題プールに登録される', () => {
  const s = setup();
  toTopic(s);
  assert.equal(s.topics.has('手入力の題材'), false);
  s.run(0, { a: 'confirmTopic', hiragana: 'さ', theme: '手入力の題材' });
  assert.deepEqual(s.room.topic, { hiragana: 'さ', theme: '手入力の題材' });
  assert.equal(s.room.phase, 'answer');
  assert.equal(s.topics.has('手入力の題材'), true);
});

test('confirmTopic：入力なしなら、いまのお題で確定する', () => {
  const s = setup();
  toTopic(s);
  s.run(0, { a: 'drawTopic', part: 'both' });
  const topic = { ...s.room.topic };
  s.run(0, { a: 'confirmTopic' });
  assert.deepEqual(s.room.topic, topic);
  assert.equal(s.room.phase, 'answer');
});

test('confirmTopic：失敗したら、題材は登録されない', () => {
  const s = setup();
  toTopic(s);
  assert.throws(() => s.run(1, { a: 'confirmTopic', hiragana: 'さ', theme: '登録されない題材' }), code('not_presenter'));
  assert.equal(s.topics.has('登録されない題材'), false);
  assert.throws(() => s.run(0, { a: 'confirmTopic', hiragana: 'さ', theme: '' }), code('bad_topic')); // 題材が空
  assert.equal(s.room.phase, 'topic');
});

// ---------- 通しの流れ ----------

test('操作だけで、1ラウンドを最後まで通せる（記名・全員投票）', () => {
  const s = setup();
  const [h, a, b] = [0, 1, 2];
  s.run(h, { a: 'advance' }); // lobby → topic
  s.run(h, { a: 'drawTopic', part: 'both' });
  s.run(h, { a: 'confirmTopic' });
  for (const i of [h, a, b]) s.run(i, { a: 'submitAnswer', text: `こたえ${i}` });
  s.run(h, { a: 'advance' }); // answer → reveal
  for (const i of [h, a, b]) s.run(i, { a: 'revealOwn' });
  s.run(h, { a: 'advance' }); // reveal → vote
  assert.equal(s.room.phase, 'vote');
  const target = s.room.viewFor(s.ids[h]).pool.find((c) => !c.mine).answerId;
  for (const i of [h, a, b]) {
    const pick = s.room.viewFor(s.ids[i]).pool.find((c) => c.canVote && c.answerId === target) ?? s.room.viewFor(s.ids[i]).pool.find((c) => c.canVote);
    s.run(i, { a: 'vote', answerId: pick.answerId });
  }
  s.run(h, { a: 'advance' }); // vote → result
  assert.equal(s.room.phase, 'result');
  assert.ok(s.room.viewFor(s.ids[h]).result.winners.length > 0);
  s.run(h, { a: 'advance' }); // 次のラウンド
  assert.equal(s.room.phase, 'topic');
  assert.equal(s.room.round, 2);
});

test('一人が決めるモード：選ぶ人だけが結果へ進める', () => {
  const s = setup();
  s.run(0, { a: 'setSettings', patch: { chooserMode: 'one' } });
  s.run(0, { a: 'advance' });
  s.run(0, { a: 'drawTopic', part: 'both' });
  s.run(0, { a: 'confirmTopic' });
  for (const i of [0, 1, 2]) s.run(i, { a: 'submitAnswer', text: `こたえ${i}` });
  s.run(0, { a: 'advance' });
  for (const i of [0, 1, 2]) s.run(i, { a: 'revealOwn' });
  s.run(0, { a: 'advance' });
  assert.equal(s.room.phase, 'vote');
  assert.equal(s.room.chooserId, s.ids[0]);
  const pick = s.room.viewFor(s.ids[0]).pool.find((c) => c.canVote);
  s.run(0, { a: 'choose', answerId: pick.answerId });
  assert.throws(() => s.run(1, { a: 'choose', answerId: pick.answerId }), code('not_allowed'));
  assert.throws(() => s.run(1, { a: 'advance' }), code('not_allowed'));
  s.run(0, { a: 'advance' });
  assert.equal(s.room.phase, 'result');
});
