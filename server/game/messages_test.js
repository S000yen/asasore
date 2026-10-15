import test from 'node:test';
import assert from 'node:assert/strict';
import { describe } from './messages.js';
import { Room } from './room.js';

const names = { a: 'あや', b: 'ボブ' };
const room = { playerName: (id) => names[id] };

test('主催者の交代：自動と手動で文面が違う', () => {
  assert.equal(describe(room, { type: 'host_transferred', to: 'a', how: 'auto' }), '主催者が不在のため、あやさんが主催者になりました');
  assert.equal(describe(room, { type: 'host_transferred', to: 'a', how: 'manual' }), 'あやさんが主催者になりました');
});

test('出題者・選ぶ人の交代と、役割の回収', () => {
  assert.equal(describe(room, { type: 'presenter_changed', to: 'b' }), 'ボブさんが出題者になりました');
  assert.equal(describe(room, { type: 'chooser_changed', to: 'b' }), 'ボブさんが正解を選ぶ人になりました');
  assert.equal(describe(room, { type: 'role_reclaimed', role: 'chooser' }), '主催者が、選ぶ人の役割を戻しました');
  assert.equal(describe(room, { type: 'role_reclaimed', role: 'presenter' }), '主催者が、出題者の役割を戻しました');
});

test('担当者が不在で、主催者に戻ったとき', () => {
  assert.equal(describe(room, { type: 'presenter_returned_to_host' }), '出題者が不在のため、主催者に戻りました');
  assert.equal(describe(room, { type: 'chooser_returned_to_host' }), '選ぶ人が不在のため、主催者に戻りました');
});

test('観戦と参戦：切り替えは通知し、次のラウンドからの予約は通知しない', () => {
  assert.equal(describe(room, { type: 'spectator_changed', id: 'a', spectator: true }), 'あやさんが観戦になりました');
  assert.equal(describe(room, { type: 'spectator_changed', id: 'a', spectator: false }), 'あやさんが参戦になりました');
  assert.equal(describe(room, { type: 'spectator_pending', id: 'a', spectator: true }), null);
});

test('時間切れ：回答なし・爆弾・通常の3通り', () => {
  assert.equal(describe(room, { type: 'time_up', noAnswer: true, bomb: true }), '時間切れ。回答がなかったので、全員不正解です'); // 回答なしが優先
  assert.equal(describe(room, { type: 'time_up', noAnswer: false, bomb: true }), '時間切れ。爆弾が爆発しました');
  assert.equal(describe(room, { type: 'time_up', noAnswer: false, bomb: false }), '時間切れ。開示へ進みます');
});

test('部屋のリセット', () => {
  assert.equal(describe(room, { type: 'room_reset' }), '主催者が部屋をリセットしました（記録と問題数を消しました）');
});

test('名前が引けない人は「誰か」と出す', () => {
  assert.equal(describe(room, { type: 'presenter_changed', to: 'nobody' }), '誰かさんが出題者になりました');
  assert.equal(describe(room, { type: 'spectator_changed', id: 'nobody', spectator: true }), '誰かさんが観戦になりました');
});

test('通知のないイベントや、イベントなしは null', () => {
  for (const ev of [undefined, null, {}, { type: 'room_closed' }, { type: 'settings_changed' }, { type: 'renamed', id: 'a' }, { type: 'unknown' }]) {
    assert.equal(describe(room, ev), null);
  }
});

test('本物の Room のイベントから、通知文が作れる', () => {
  const r = new Room('T');
  const host = r.join(null, 'ホスト', 1000).id;
  const other = r.join(null, 'ゲスト', 1001).id;
  assert.equal(describe(r, r.transferHost(host, other)), 'ゲストさんが主催者になりました');
});
