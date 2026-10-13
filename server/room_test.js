import test from 'node:test';
import assert from 'node:assert/strict';
import { Room } from './room.js';

// n人入室した部屋を作る。ids[0] が主催者。
function setup(n = 3, opts = {}) {
  const room = new Room('TEST', opts);
  const names = ['A', 'B', 'C', 'D', 'E'];
  const ids = [];
  for (let i = 0; i < n; i++) ids.push(room.join(null, names[i], 1000 + i).id);
  return { room, ids };
}

function toAnswerPhase(room, ids) {
  room.startRound(ids[0]);
  room.setTopic(ids[0], { hiragana: 'あ', theme: '面白いもの' });
  room.confirmTopic(ids[0]);
}

test('記名モードの通しの流れ（多数決）', () => {
  const { room, ids } = setup(3);
  const [A, B, C] = ids;
  assert.equal(room.hostId, A);

  room.startRound(A);
  assert.equal(room.presenterId, A); // 毎ラウンド主催者に戻す（デフォルト）
  assert.throws(() => room.setTopic(B, { hiragana: 'あ', theme: 'x' }), { code: 'not_presenter' });
  room.setTopic(A, { hiragana: 'あ', theme: '面白いもの' });
  // 確定前は出題者本人にしかお題が見えない
  assert.equal(room.viewFor(B).topic, null);
  room.confirmTopic(A);
  assert.deepEqual(room.viewFor(B).topic, { hiragana: 'あ', theme: '面白いもの' });

  room.submitAnswer(A, '足の裏');
  room.submitAnswer(B, 'アヒル');
  room.submitAnswer(C, 'あくび');
  assert.equal(room.advance(A).needConfirm, false);
  assert.equal(room.phase, 'reveal');

  room.revealOwn(B); // 各自で開示
  room.revealAll(A); // 残りは主催者が一括で
  assert.equal(room.advance(A).phase, 'vote');

  assert.throws(() => room.vote(B, room.viewFor(B).answers.find((a) => a.mine).answerId), { code: 'self_vote' });
  const idOf = (name) => room.viewFor(A).answers.find((a) => a.author === name).answerId;
  room.vote(A, idOf('B'));
  room.vote(B, idOf('C'));
  room.vote(C, idOf('B'));
  room.advance(A);
  const r = room.viewFor(C).result;
  assert.equal(room.phase, 'result');
  assert.equal(r.tie, false);
  assert.equal(r.tallies.find((t) => t.answerId === r.winners[0]).author, 'B');
});

test('未回答の人がいると確認を返し、force で進める', () => {
  const { room, ids } = setup(3);
  toAnswerPhase(room, ids);
  room.submitAnswer(ids[0], 'x');
  room.submitAnswer(ids[1], 'y');
  const res = room.advance(ids[0]);
  assert.equal(res.needConfirm, true);
  assert.deepEqual(res.pending.names, ['C']);
  assert.equal(room.phase, 'answer');
  assert.equal(room.advance(ids[0], { force: true }).phase, 'reveal');
});

test('匿名モードでは結果発表まで作者が出ない（主催者にも）', () => {
  const { room, ids } = setup(3);
  const [A, B, C] = ids;
  room.setSettings(A, { identityMode: 'anonymous' });
  toAnswerPhase(room, ids);
  room.submitAnswer(A, 'a1');
  room.submitAnswer(B, 'b1');
  room.submitAnswer(C, 'c1');
  room.advance(A);

  // 開示前、主催者は内容を見られるが作者は見えない
  const hostView = room.viewFor(A);
  assert.equal(hostView.unrevealed.length, 3);
  assert.ok(hostView.unrevealed.every((a) => a.author === null));
  // 他の参加者には自分の分しか見えない
  assert.equal(room.viewFor(B).unrevealed.length, 1);
  assert.equal(room.viewFor(B).unrevealed[0].mine, true);

  // 選択開示
  room.revealSelected(A, hostView.unrevealed.find((a) => a.text === 'b1').answerId);
  assert.equal(room.viewFor(C).answers.length, 1);
  assert.equal(room.viewFor(C).answers[0].author, null);
  assert.throws(() => room.revealOwn(B), { code: 'wrong_mode' });

  room.revealAll(A);
  room.advance(A);
  const toC = room.viewFor(C).answers;
  const json = JSON.stringify(toC);
  assert.ok(!json.includes('ownerId'));
  assert.ok(toC.every((a) => a.author === null));

  const pick = toC.find((a) => !a.mine).answerId;
  room.vote(C, pick);
  room.advance(A, { force: true });
  assert.ok(room.viewFor(C).result.tallies.every((t) => typeof t.author === 'string')); // 結果で明かす
});

test('主催者が落ちると、猶予後に一番早く参加した接続中の人へ移る', () => {
  const { room, ids } = setup(3, { graceMs: 1000 });
  const [A, B, C] = ids;
  room.disconnect(B, 5000); // 2番目に参加した人が先に落ちている
  room.disconnect(A, 5000);
  assert.deepEqual(room.tick(5999), []);
  assert.equal(room.hostId, A);
  const ev = room.tick(6000);
  assert.equal(ev[0].type, 'host_transferred');
  assert.equal(room.hostId, C); // B は不在なので C
  assert.equal(room.presenterId, C); // 出題者を兼ねていた権限も移る
  // 元の主催者が戻っても一般参加者のまま
  room.join(A, null);
  assert.equal(room.hostId, C);
});

test('任意の譲渡は接続中の人にだけできる', () => {
  const { room, ids } = setup(3);
  room.disconnect(ids[2]);
  assert.throws(() => room.transferHost(ids[0], ids[2]), { code: 'not_connected' });
  room.transferHost(ids[0], ids[1]);
  assert.equal(room.hostId, ids[1]);
  assert.throws(() => room.transferHost(ids[0], ids[1]), { code: 'not_host' });
});

test('削除すると集計・表示から外れ、再入室許可で回答ごと戻る', () => {
  const { room, ids } = setup(3);
  const [A, B, C] = ids;
  toAnswerPhase(room, ids);
  room.submitAnswer(A, 'a');
  room.submitAnswer(B, 'b');
  room.submitAnswer(C, 'c');
  room.removePlayer(A, B);
  assert.throws(() => room.join(B, null), { code: 'banned' });
  room.advance(A);
  room.revealAll(A);
  assert.equal(room.viewFor(A).answers.length, 2); // B の回答は出ない
  assert.equal(room.viewFor(A).players.length, 2);
  assert.equal(room.players.get(B).removed, true); // 内部には残っている
  room.allowRejoin(A, B);
  room.join(B, null);
  assert.equal(room.viewFor(A).players.length, 3);
  assert.equal(room.answers.get(B).text, 'b');
});

test('順番方式：参加順に回り、並べ替えと欠席の飛ばしに対応する', () => {
  const { room, ids } = setup(3);
  const [A, B, C] = ids;
  room.setSettings(A, { presenterMode: 'rotation' });
  const seq = [];
  const nextRound = () => {
    room.startRound(A);
    seq.push(room.presenterId);
    room.setTopic(room.presenterId, { hiragana: 'あ', theme: 'もの' });
    room.confirmTopic(room.presenterId);
    room.submitAnswer(A, 'x');
    room.advance(A, { force: true });
    room.revealAll(A);
    room.advance(A, { force: true });
    room.advance(A, { force: true }); // → result
  };
  nextRound();
  nextRound();
  nextRound();
  nextRound();
  assert.deepEqual(seq, [A, B, C, A]); // 初回は参加順の先頭から、以後は順に一巡する

  room.setSettings(A, { order: [C, B, A] });
  assert.deepEqual(room.settings.order, [C, B, A]);
  room.disconnect(C);
  room.startRound(A);
  assert.notEqual(room.presenterId, C);
});

test('出題者の委譲と、確定前の指名し直し', () => {
  const { room, ids } = setup(3);
  const [A, B, C] = ids;
  room.startRound(A);
  room.setTopic(A, { hiragana: 'い', theme: '怖いもの' });
  room.setPresenter(A, B); // 主催者が委譲
  assert.equal(room.topic, null); // 下書きは白紙に
  room.setPresenter(B, C); // 出題者がさらに委譲
  assert.equal(room.presenterId, C);
  assert.throws(() => room.setPresenter(B, A), { code: 'not_allowed' });
  room.setPresenter(A, A); // 主催者はいつでも指名し直せる
  assert.equal(room.presenterId, A);
});

test('空き部屋は一定時間後に閉じ、記録は破棄される', () => {
  const { room, ids } = setup(2, { emptyCloseMs: 1000, now: 0 }); // テスト内の擬似時刻に合わせる
  ids.forEach((id) => room.disconnect(id, 2000));
  assert.equal(room.shouldClose(2999), false);
  const ev = room.tick(3000);
  assert.equal(ev.at(-1).type, 'room_closed');
  assert.equal(room.players.size, 0);
});

test('名前が空なら「ユーザーN」になり、空いている最小の番号が付く', () => {
  const room = new Room('TEST');
  const a = room.join(null, '');
  const b = room.join(null, '   ');
  const c = room.join(null, undefined);
  assert.deepEqual([a.name, b.name, c.name], ['ユーザー1', 'ユーザー2', 'ユーザー3']);
  room.rename(b.id, 'ぼく'); // 2番が空いたら、次の人に回る
  assert.equal(room.join(null, '').name, 'ユーザー2');
});

test('入室時に名前が重なったら、末尾に番号を付けて入れる', () => {
  const room = new Room('TEST');
  room.join(null, 'とーや');
  assert.equal(room.join(null, 'とーや').name, 'とーや2');
  assert.equal(room.join(null, 'とーや').name, 'とーや3');
});

test('表示名の変更：参加中ならいつでも可、空・長すぎ・重複は断る', () => {
  const { room, ids } = setup(2);
  const [A, B] = ids;
  room.rename(B, 'ぼく');
  assert.equal(room.players.get(B).name, 'ぼく');
  assert.equal(room.viewFor(A).players.find((p) => p.id === B).name, 'ぼく'); // 他の人の画面にも反映
  assert.throws(() => room.rename(B, '  '), { code: 'bad_name' });
  assert.throws(() => room.rename(B, 'あ'.repeat(21)), { code: 'bad_name' });
  assert.throws(() => room.rename(B, 'A'), { code: 'name_taken' }); // 主催者の名前
  room.rename(B, 'ぼく'); // 自分の今の名前に変えるのは問題なし
  room.removePlayer(A, B);
  assert.throws(() => room.rename(B, 'x'), { code: 'no_such_player' }); // 外された人は変えられない
});

test('回答の途中で名前を変えても、匿名モードの作者は漏れない', () => {
  const { room, ids } = setup(3);
  const [A, B] = ids;
  room.setSettings(A, { identityMode: 'anonymous' });
  toAnswerPhase(room, ids);
  room.submitAnswer(B, 'こたえ');
  room.rename(B, 'べつの名前');
  room.advance(A, { force: true }); // 回答 → 開示
  room.revealAll(A);
  const seen = JSON.stringify(room.viewFor(A));
  assert.equal(seen.includes('べつの名前'), true); // 参加者一覧には出る
  assert.equal(room.viewFor(A).answers.every((a) => !a.author), true); // 回答に作者は付かない
});
