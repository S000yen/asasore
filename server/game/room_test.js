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

// まだ投票していない全員が、自分以外の回答に投票する（投票が揃わないと結果へ進めないため）
function voteAll(room, ids) {
  for (const id of ids) {
    const v = room.viewFor(id);
    if (v.myVote) continue;
    const cell = v.pool.find((c) => c.canVote);
    if (cell) room.vote(id, cell.answerId);
  }
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

  // 開示前、主催者には全部黒塗り（中身も作者も見えない）。開示は主催者だけができる
  const hostView = room.viewFor(A);
  assert.equal(hostView.unrevealed.length, 3);
  assert.ok(hostView.unrevealed.every((a) => a.author === null && a.text === null && a.canReveal));
  // 他の参加者には、自分の分だけ中身が先頭に見え、あとは黒塗りの枠（枠の数は見える）
  const bView = room.viewFor(B).unrevealed;
  assert.equal(bView.length, 3);
  assert.deepEqual([bView[0].mine, bView[0].text, bView[0].canReveal], [true, 'b1', false]);
  assert.ok(bView.slice(1).every((s) => s.text === null && s.answerId === null && s.author === null));
  assert.ok(!room.viewFor(C).unrevealed.some((s) => s.text === 'b1')); // （idにたまたま含まれる文字列で揺れないよう、本文で見る）

  // 選択開示（主催者は中身を見ずに枠を選ぶ）
  room.revealSelected(A, hostView.unrevealed[0].answerId);
  assert.equal(room.viewFor(C).answers.length, 1);
  assert.equal(room.viewFor(C).answers[0].author, null);
  assert.equal(room.viewFor(C).unrevealed.length, 2);
  assert.throws(() => room.revealOwn(B), { code: 'wrong_mode' });

  room.revealAll(A);
  room.advance(A);
  const toC = room.viewFor(C).answers;
  const json = JSON.stringify(toC);
  assert.ok(!json.includes('ownerId'));
  assert.ok(toC.every((a) => a.author === null));

  const pick = toC.find((a) => !a.mine).answerId;
  room.vote(C, pick);
  voteAll(room, ids);
  room.advance(A);
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
    voteAll(room, ids);
    room.advance(A); // → result
  };
  nextRound();
  nextRound();
  nextRound();
  nextRound();
  assert.deepEqual(seq, [A, B, C, A]); // 初回は参加順の先頭から、以後は順に一巡する

  room.join(null, 'D', 2000); // 3人以上いないと始められないので、1人欠けても足りるよう追加
  room.setSettings(A, { order: [C, B, A] });
  assert.deepEqual(room.settings.order.slice(0, 3), [C, B, A]);
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
  assert.throws(() => room.setPresenter(A, A), { code: 'not_allowed' }); // 任せたあとは、主催者でも変えられない
  assert.equal(room.presenterId, C);
  room.disconnect(C, 0); // 出題者が不在なら、主催者に権限が戻る
  room.setPresenter(A, A);
  assert.equal(room.presenterId, A);
});

test('ランダム指名は、本人も含めた全員から選ぶ', () => {
  const { room, ids } = setup(3);
  const [A] = ids;
  room.startRound(A);
  const seen = new Set();
  for (let i = 0; i < 300; i++) { room.randomPresenter(room.presenterId); seen.add(room.presenterId); } // 担当者本人が引く
  assert.equal(seen.size, 3); // 引いた本人も、いまの担当者も含めて3人とも出る
});

test('出題者・選ぶ人は、次のラウンドにも引き継がれる（いなければ主催者）', () => {
  const { room, ids } = setup(3);
  const [A, B, C] = ids;
  room.setSettings(A, { chooserMode: 'one' });
  room.startRound(A);
  room.setPresenter(A, B);
  room.setTopic(B, { hiragana: 'い', theme: '怖いもの' });
  room.confirmTopic(B);
  room.submitAnswer(A, 'a1'); room.submitAnswer(B, 'b1'); room.submitAnswer(C, 'c1');
  room.advance(A); room.revealAll(A); room.advance(A);
  room.setChooser(A, C);
  room.choose(C, room.viewFor(C).pool.find((c) => c.text === 'a1').answerId);
  room.advance(C);
  room.startRound(A);
  assert.equal(room.presenterId, B); // 出題者はそのまま
  room.setTopic(B, { hiragana: 'う', theme: '甘いもの' });
  room.confirmTopic(B);
  room.submitAnswer(A, 'a2'); room.submitAnswer(B, 'b2'); room.submitAnswer(C, 'c2');
  room.advance(A); room.revealAll(A); room.advance(A);
  assert.equal(room.chooserId, C); // 選ぶ人もそのまま
  assert.equal(room.choice, null);
});

test('選ぶ人を任せたあとは、主催者でも変えられない。不在なら主催者に戻る／ランダムは本人も含む', () => {
  const { room, ids } = setup(3);
  const [A, B, C] = ids;
  room.setSettings(A, { chooserMode: 'one' });
  toAnswerPhase(room, ids);
  room.submitAnswer(A, 'a1'); room.submitAnswer(B, 'b1'); room.submitAnswer(C, 'c1');
  room.advance(A); room.revealAll(A); room.advance(A);
  room.setChooser(A, B);
  assert.throws(() => room.setChooser(A, C), { code: 'not_allowed' });
  assert.throws(() => room.randomChooser(A), { code: 'not_allowed' });
  const seen = new Set();
  for (let i = 0; i < 300; i++) { room.randomChooser(room.chooserId); seen.add(room.chooserId); }
  assert.equal(seen.size, 3);
  room.setChooser(room.chooserId, B);
  room.disconnect(B, 0);
  room.tick(10 ** 9); // 猶予を過ぎる
  assert.equal(room.chooserId, A); // 主催者に戻る
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
  assert.throws(() => room.rename(B, 'あ'.repeat(201)), { code: 'bad_name' });
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

test('確定した題材は、その部屋の「使った題材」になる。引き直しだけでは、ならない', () => {
  const { room, ids } = setup(3);
  const [A] = ids;
  room.startRound(A);
  room.setTopic(A, { hiragana: 'あ', theme: '引き直した題材' });
  room.setTopic(A, { hiragana: 'あ', theme: '回した題材' });
  assert.equal(room.usedThemes.size, 0);
  room.confirmTopic(A);
  assert.deepEqual([...room.drawFilter().used], ['回した題材']);
});

test('報告：出題者だけが、いまのお題を報告でき、その部屋では出なくなる', () => {
  const { room, ids } = setup(3);
  const [A, B] = ids;
  room.startRound(A);
  room.setTopic(A, { hiragana: 'あ', theme: 'おかしい題材' });
  assert.throws(() => room.reportTopic(B, 'おかしい題材'), { code: 'not_presenter' });
  assert.throws(() => room.reportTopic(A, '別の題材'), { code: 'bad_topic' }); // いまのお題と違う
  room.reportTopic(A, 'おかしい題材');
  assert.deepEqual([...room.drawFilter().blocked], ['おかしい題材']);
  assert.equal(room.usedThemes.size, 0); // 回していないので、使った題材にはならない
});

test('報告は、お題を選んでいる間だけできる', () => {
  const { room, ids } = setup(3);
  const [A] = ids;
  assert.throws(() => room.reportTopic(A, 'x'), { code: 'bad_phase' }); // ロビー
  toAnswerPhase(room, ids);
  assert.throws(() => room.reportTopic(A, '面白いもの'), { code: 'bad_phase' }); // 回答中
});

test('部屋を閉じると、使った題材・報告の記録も破棄される', () => {
  const { room, ids } = setup(3);
  toAnswerPhase(room, ids);
  room.close(ids[0]);
  assert.equal(room.usedThemes.size + room.blockedThemes.size, 0);
});

test('記録：結果が出たラウンドだけ、新しい順に見られる。途中のラウンドは出ない', () => {
  const { room, ids } = setup(3, { identityMode: 'anonymous' });
  const [A, B, C] = ids;
  room.setSettings(A, { identityMode: 'anonymous' });
  const play = (theme) => {
    room.startRound(A);
    room.setTopic(A, { hiragana: 'あ', theme });
    room.confirmTopic(A);
    room.submitAnswer(A, `${theme}のA`); room.submitAnswer(B, `${theme}のB`); room.submitAnswer(C, `${theme}のC`);
    room.advance(A); room.revealAll(A); room.advance(A);
    const answers = room.viewFor(A).answers;
    const b = answers.find((a) => a.text === `${theme}のB`).answerId;
    room.vote(A, b); room.vote(C, b);
    room.vote(B, answers.find((a) => a.text === `${theme}のA`).answerId); // Bは、Aに投票
  };
  play('一つ目');
  assert.deepEqual(room.viewFor(A).history, []); // まだ結果が出ていない（投票中）
  room.advance(A);
  let h = room.viewFor(C).history;
  assert.equal(h.length, 1);
  assert.equal(h[0].topic.theme, '一つ目');
  assert.deepEqual(h[0].entries.map((e) => [e.author, e.votes, e.won]), [['B', 2, true], ['A', 1, false], ['C', 0, false]]);
  play('二つ目');
  assert.deepEqual(room.viewFor(B).history.map((x) => x.topic.theme), ['一つ目']); // 投票中は、前のラウンドまで
  voteAll(room, ids);
  room.advance(A);
  h = room.viewFor(B).history;
  assert.deepEqual(h.map((x) => x.round), [2, 1]);
  assert.equal(h[0].entries[0].text, '二つ目のB');
});

test('記名モードの開示：本人だけが自分の枠を開け、他の人の枠は名前つきの黒塗り', () => {
  const { room, ids } = setup(3);
  const [A, B, C] = ids;
  toAnswerPhase(room, ids);
  room.submitAnswer(A, 'a1'); room.submitAnswer(B, 'b1'); room.submitAnswer(C, 'c1');
  room.advance(A);
  const v = room.viewFor(B).unrevealed;
  assert.deepEqual([v[0].mine, v[0].text, v[0].canReveal], [true, 'b1', true]);
  assert.deepEqual(v.slice(1).map((s) => s.author).sort(), ['A', 'C']);
  assert.ok(v.slice(1).every((s) => s.text === null && s.canReveal === false));
  room.revealOwn(B);
  assert.equal(room.viewFor(C).answers.length, 1);
  assert.equal(room.viewFor(B).unrevealed.length, 2);
});

test('3人未満では始められない', () => {
  const { room, ids } = setup(2);
  assert.throws(() => room.startRound(ids[0]), { code: 'min_players' });
  room.join(null, 'C', 3000);
  assert.doesNotThrow(() => room.startRound(ids[0]));
});

test('回答は取り下げるまで書き換えられない', () => {
  const { room, ids } = setup(3);
  toAnswerPhase(room, ids);
  room.submitAnswer(ids[1], 'こたえ');
  assert.throws(() => room.submitAnswer(ids[1], 'べつの'), { code: 'already_answered' });
  assert.equal(room.viewFor(ids[1]).myAnswer, 'こたえ');
  room.withdrawAnswer(ids[1]);
  room.submitAnswer(ids[1], 'べつの');
  assert.equal(room.viewFor(ids[1]).myAnswer, 'べつの');
});

test('「一人が決める」モード：選ぶ人だけが正解を選べて、選び直せる。投票はできない', () => {
  const { room, ids } = setup(3);
  const [A, B, C] = ids;
  room.setSettings(A, { chooserMode: 'one' });
  toAnswerPhase(room, ids);
  room.submitAnswer(A, 'a1'); room.submitAnswer(B, 'b1'); room.submitAnswer(C, 'c1');
  room.advance(A); room.revealAll(A); room.advance(A);
  assert.equal(room.viewFor(A).chooserId, A);
  assert.ok(room.viewFor(A).me.isChooser && !room.viewFor(B).me.isChooser);
  const poolB = room.viewFor(B).pool, poolA = room.viewFor(A).pool;
  assert.ok(poolB.every((c) => !c.canVote));
  assert.equal(poolA.filter((c) => c.canVote).length, 2); // 自分の回答は選べない
  assert.throws(() => room.vote(B, poolA[0].answerId), { code: 'wrong_mode' });
  const idOf = (txt) => room.viewFor(A).pool.find((c) => c.text === txt).answerId;
  assert.throws(() => room.choose(B, idOf('a1')), { code: 'not_allowed' });
  assert.throws(() => room.choose(A, idOf('a1')), { code: 'self_vote' });
  room.choose(A, idOf('b1'));
  room.choose(A, idOf('c1')); // 選び直し
  assert.equal(room.viewFor(B).myVote, idOf('c1'));
  room.advance(A);
  const r = room.viewFor(B).result;
  assert.deepEqual(r.winners, [idOf('c1')]);
  assert.equal(r.mode, 'one');
});

test('「一人が決める」モード：選ぶ人を任せる／選ばないまま進むと確認が出る', () => {
  const { room, ids } = setup(3);
  const [A, B, C] = ids;
  room.setSettings(A, { chooserMode: 'one' });
  toAnswerPhase(room, ids);
  room.submitAnswer(A, 'a1'); room.submitAnswer(B, 'b1'); room.submitAnswer(C, 'c1');
  room.advance(A); room.revealAll(A); room.advance(A);
  assert.throws(() => room.setChooser(C, B), { code: 'not_allowed' });
  assert.throws(() => room.advance(A), { code: 'votes_pending' }); // まだ選ばれていない（結果へ進めない）
  room.setChooser(A, B);
  assert.equal(room.viewFor(C).chooserId, B);
  assert.throws(() => room.choose(A, room.viewFor(A).pool[0].answerId), { code: 'not_allowed' });
  const target = room.viewFor(B).pool.find((c) => c.text === 'a1').answerId;
  room.choose(B, target);
  room.setChooser(B, C); // 選ぶ人から、さらに任せられる
  assert.throws(() => room.advance(A), { code: 'not_allowed' }); // 結果へ進めるのは選ぶ人だけ（主催者は不可）
  room.advance(C); // 選択は、任された人に引き継がれる

  assert.deepEqual(room.viewFor(A).result.winners, [target]);
});

test('全員投票モードでは、選ぶ操作はできない', () => {
  const { room, ids } = setup(3);
  const [A, B, C] = ids;
  toAnswerPhase(room, ids);
  room.submitAnswer(A, 'a1'); room.submitAnswer(B, 'b1'); room.submitAnswer(C, 'c1');
  room.advance(A); room.revealAll(A); room.advance(A);
  assert.throws(() => room.choose(A, room.viewFor(A).pool[1].answerId), { code: 'wrong_mode' });
  assert.equal(room.viewFor(A).chooserId, null);
});

test('全員投票モード：未投票でも、主催者は確認のうえ早く進められる', () => {
  const { room, ids } = setup(3);
  const [A, B, C] = ids;
  toAnswerPhase(room, ids);
  room.submitAnswer(A, 'a1'); room.submitAnswer(B, 'b1'); room.submitAnswer(C, 'c1');
  room.advance(A); room.revealAll(A); room.advance(A);
  assert.equal(room.viewFor(A).pendingCount, 3);
  assert.equal(room.advance(A).needConfirm, true);
  voteAll(room, [A]);
  assert.equal(room.viewFor(A).pendingCount, 2);
  assert.equal(room.advance(A, { force: true }).phase, 'result');
});

test('主催者は、任せた役割（出題者・選ぶ人）を強制的に回収できる', () => {
  const { room, ids } = setup(3);
  const [A, B, C] = ids;
  room.setSettings(A, { chooserMode: 'one' });
  room.startRound(A);
  assert.equal(room.viewFor(A).me.canReclaim, false);
  room.setPresenter(A, B);
  assert.equal(room.viewFor(A).me.canReclaim, true);
  assert.throws(() => room.reclaimRole(C), { code: 'not_host' });
  room.reclaimRole(A);
  assert.equal(room.presenterId, A);
  room.setTopic(A, { hiragana: 'い', theme: '怖いもの' }); room.confirmTopic(A);
  room.submitAnswer(A, 'a1'); room.submitAnswer(B, 'b1'); room.submitAnswer(C, 'c1');
  room.advance(A); room.revealAll(A); room.advance(A);
  room.setChooser(A, B);
  assert.throws(() => room.setChooser(A, C), { code: 'not_allowed' });
  room.reclaimRole(A);
  assert.equal(room.chooserId, A);
  assert.throws(() => room.reclaimRole(A), { code: 'nothing_to_reclaim' });
});

// ---------- 同じ回答のグループ化 ----------

function toReveal(room, ids, texts) {
  toAnswerPhase(room, ids);
  ids.forEach((id, i) => room.submitAnswer(id, texts[i]));
  room.advance(ids[0]); // 開示へ
  room.revealAll(ids[0]);
}
const ansOf = (room, id) => room.viewFor(id).pool.find((c) => c.mine).answerId;

test('グループ化：主催者だけ、開示中にまとめられ、解除もできる', () => {
  const { room, ids } = setup(4);
  const [A, B, C, D] = ids;
  toReveal(room, ids, ['ねこ', 'ネコ', 'いぬ', 'うま']);
  const [a, b, c] = [A, B, C].map((id) => ansOf(room, id));
  assert.throws(() => room.group(B, [a, b]), { code: 'not_host' });
  assert.throws(() => room.group(A, [a]), { code: 'few' });
  room.group(A, [a, b]);
  const cells = room.viewFor(D).pool;
  assert.equal(cells.find((x) => x.answerId === a).group, 1);
  assert.equal(cells.find((x) => x.answerId === b).group, 1);
  assert.equal(cells.find((x) => x.answerId === c).group, null);
  assert.equal(room.viewFor(A).pool.every((x) => x.canGroup), true);
  assert.equal(room.viewFor(B).pool.some((x) => x.canGroup), false);
  room.group(A, [b, c]); // 重なれば1つに合わさる
  assert.equal(room.viewFor(D).pool.filter((x) => x.group === 1).length, 3);
  room.ungroup(A, [c]); // 外すと2つに戻る
  assert.equal(room.viewFor(D).pool.filter((x) => x.group === 1).length, 2);
  room.ungroup(A, [a]); // 残り1つになれば解消
  assert.equal(room.viewFor(D).pool.filter((x) => x.group).length, 0);
});

test('グループ化：投票はまとまりで数え、勝つとまとまり全員が正解。同じ回答の人もそのまとまりに投票できる', () => {
  const { room, ids } = setup(5);
  const [A, B, C, D, E] = ids;
  toReveal(room, ids, ['ねこ', 'ネコ', 'いぬ', 'うま', 'とり']);
  const [a, b, c] = [A, B, C].map((id) => ansOf(room, id));
  room.advance(A); // 投票へ
  room.group(A, [a, b]); // 投票中でもまとめられる
  assert.throws(() => room.vote(C, c), { code: 'self_vote' }); // まとまりに入っていない自分の回答には投票できない
  assert.equal(room.viewFor(C).pool.find((x) => x.answerId === c).canVote, false);
  assert.equal(room.viewFor(A).pool.find((x) => x.answerId === b).canVote, true); // 同じ回答の人は、まとまりに投票できる
  room.vote(A, b); room.vote(B, a); room.vote(C, a); room.vote(E, a); // まとまりへ4票
  room.vote(D, c);
  room.advance(A);
  const r = room.viewFor(A).result;
  assert.deepEqual([...r.winners].sort(), [a, b].sort());
  assert.equal(r.tie, false);
  assert.equal(r.tallies.find((t) => t.answerId === a).votes, 4);
  assert.equal(r.tallies.find((t) => t.answerId === b).votes, 4);
  assert.equal(r.tallies.find((t) => t.answerId === a).group, 1);
  assert.equal(room.viewFor(A).history[0].total, 5);
});

test('グループ化：ばらして自分だけの回答への票になったものは取り消される', () => {
  const { room, ids } = setup(4);
  const [A, B, C, D] = ids;
  toReveal(room, ids, ['ねこ', 'ネコ', 'いぬ', 'うま']);
  const [a, b] = [A, B].map((id) => ansOf(room, id));
  room.advance(A);
  room.group(A, [a, b]);
  room.vote(A, a); // 自分の回答だが、まとまりなので投票できる
  room.vote(C, a);
  assert.equal(room.viewFor(A).myVote, a);
  room.ungroup(A, [a]); // まとまりが解消 → Aの票は自分だけの回答への票になる
  assert.equal(room.viewFor(A).myVote, null);
  assert.equal(room.viewFor(C).myVote, a); // Cの票は残る
});

test('グループ化：「一人が決める」モードでも、選ぶとまとまり全員が正解', () => {
  const { room, ids } = setup(4);
  const [A, B, C, D] = ids;
  room.setSettings(A, { chooserMode: 'one' });
  toReveal(room, ids, ['ねこ', 'ネコ', 'いぬ', 'うま']);
  const [a, b, c] = [A, B, C].map((id) => ansOf(room, id));
  room.advance(A); // 投票へ。選ぶ人は主催者A
  room.group(A, [b, c]);
  room.choose(A, b);
  room.advance(A);
  assert.deepEqual([...room.viewFor(A).result.winners].sort(), [b, c].sort());
});

test('グループ化：投票の前後以外ではできない', () => {
  const { room, ids } = setup(3);
  toAnswerPhase(room, ids);
  room.submitAnswer(ids[0], 'a'); room.submitAnswer(ids[1], 'b');
  assert.throws(() => room.group(ids[0], ['x', 'y']), { code: 'bad_phase' });
});

test('回答待ちの間だけ、経過秒が届く', () => {
  const { room, ids } = setup(3);
  toAnswerPhase(room, ids);
  const sec = room.viewFor(ids[1]).answerSec;
  assert.ok(Number.isInteger(sec) && sec >= 0);
  room.submitAnswer(ids[0], 'a'); room.submitAnswer(ids[1], 'b'); room.submitAnswer(ids[2], 'c');
  room.advance(ids[0]);
  assert.equal(room.viewFor(ids[1]).answerSec, undefined);
});

test('反応マーク：開示中だけ。決まった種類だけ。連打は間引かれる', () => {
  const { room, ids } = setup(3);
  const [A, B] = ids;
  toAnswerPhase(room, ids);
  assert.throws(() => room.react(B, 'like'), { code: 'bad_phase' }); // 回答中は使えない
  ids.forEach((id, i) => room.submitAnswer(id, ['a', 'b', 'c'][i]));
  room.advance(A); // 開示へ
  assert.deepEqual(room.react(B, 'like'), { type: 'react', kind: 'like' });
  assert.equal(room.react(B, 'bad'), null); // 0.12秒以内の連打は無視
  assert.throws(() => room.react(A, 'fire'), { code: 'bad_reaction' });
  assert.deepEqual(room.react(A, 'cheer'), { type: 'react', kind: 'cheer' }); // 人ごとに数える
  room.revealAll(A);
  room.advance(A); // 投票へ
  assert.throws(() => room.react(B, 'laugh'), { code: 'bad_phase' }); // 投票中は使えない
});

// ---------- 観戦／参戦と、部屋のリセット ----------

test('観戦：観戦で入れる。回答・投票はできず、人数にも数えない。反応マークは使える', () => {
  const room = new Room('TEST');
  const A = room.join(null, 'A', 1).id, B = room.join(null, 'B', 2).id, C = room.join(null, 'C', 3).id;
  const W = room.join(null, 'W', 4, { spectator: true }).id;
  assert.equal(room.viewFor(W).me.spectator, true);
  assert.equal(room.viewFor(A).players.find((p) => p.id === W).spectator, true);
  room.startRound(A);
  room.setTopic(A, { hiragana: 'あ', theme: '面白いもの' });
  room.confirmTopic(A);
  assert.throws(() => room.submitAnswer(W, 'x'), { code: 'spectating' });
  [A, B, C].forEach((id, i) => room.submitAnswer(id, ['a', 'b', 'c'][i]));
  assert.equal(room.advance(A).needConfirm, false); // 観戦者は未回答に数えない
  assert.ok(room.react(W, 'like')); // 開示中は反応マークを送れる
  room.revealAll(A);
  room.advance(A);
  assert.throws(() => room.vote(W, room.viewFor(A).pool[0].answerId), { code: 'spectating' });
  assert.equal(room.viewFor(W).pool.some((c) => c.canVote), false);
  [A, B, C].forEach((id) => { const c = room.viewFor(id).pool.find((x) => x.canVote); room.vote(id, c.answerId); });
  assert.equal(room.advance(A).needConfirm, false); // 観戦者は未投票に数えない
});

test('観戦：最初の人（主催者）は参戦で入る。主催者も観戦に切り替えられて、出題者も任せられる', () => {
  const room = new Room('TEST');
  const A = room.join(null, 'A', 1, { spectator: true }).id;
  assert.equal(room.viewFor(A).me.spectator, false);
  const B = room.join(null, 'B', 2).id, C = room.join(null, 'C', 3).id, D = room.join(null, 'D', 4).id;
  room.setSpectator(A, true); // ロビーなら、すぐ
  assert.equal(room.viewFor(A).me.spectator, true);
  room.startRound(A);
  assert.equal(room.presenterId, A); // 観戦中の主催者が、出題者のまま
  room.setPresenter(A, B);
  room.setPresenter(B, A); // 観戦中の人にも任せられる
  assert.equal(room.presenterId, A);
  room.setTopic(A, { hiragana: 'あ', theme: 'x' });
  room.confirmTopic(A);
  assert.equal(room.phase, 'answer');
  assert.ok(C && D);
});

test('観戦：人数は参戦の人だけで数える。観戦から参戦へ切り替えると始められる', () => {
  const room = new Room('TEST');
  const A = room.join(null, 'A', 1).id, B = room.join(null, 'B', 2).id;
  const W = room.join(null, 'W', 3, { spectator: true }).id;
  assert.throws(() => room.startRound(A), { code: 'min_players' }); // 参戦は2人だけ
  room.setSpectator(W, false); // ロビーなら、すぐ参戦
  assert.equal(room.viewFor(W).me.spectator, false);
  room.startRound(A);
});

test('観戦：回答中までは、すぐ切り替わる（回答済みの人が観戦になると回答は取り下げ）', () => {
  const room = new Room('TEST');
  const [A, B, C, D] = ['A', 'B', 'C', 'D'].map((n, i) => room.join(null, n, i + 1).id);
  room.startRound(A);
  room.setTopic(A, { hiragana: 'あ', theme: 'x' });
  room.confirmTopic(A);
  room.submitAnswer(D, 'd');
  const ev = room.setSpectator(D, true); // 回答中なので、すぐ
  assert.equal(ev.type, 'spectator_changed');
  assert.equal(room.viewFor(D).me.spectator, true);
  assert.equal(room.viewFor(D).myAnswer, null);
  room.setSpectator(D, false);
  room.submitAnswer(D, 'd2'); // 参戦に戻れば、また回答できる
});

test('観戦：開示から先で頼むと、次のラウンドから切り替わる。取り消しもできる', () => {
  const room = new Room('TEST');
  const [A, B, C, D] = ['A', 'B', 'C', 'D'].map((n, i) => room.join(null, n, i + 1).id);
  room.startRound(A);
  room.setTopic(A, { hiragana: 'あ', theme: 'x' });
  room.confirmTopic(A);
  [A, B, C, D].forEach((id, i) => room.submitAnswer(id, 'abcd'[i]));
  room.advance(A); // 開示へ
  const ev = room.setSpectator(D, true);
  assert.equal(ev.type, 'spectator_pending');
  assert.equal(room.viewFor(D).me.spectator, false); // まだ参戦のまま
  assert.equal(room.viewFor(D).me.nextSpectator, true);
  room.setSpectator(D, false); // 取り消し
  assert.equal(room.viewFor(D).me.nextSpectator, null);
  room.setSpectator(D, true);
  room.revealAll(A); room.advance(A);
  [A, B, C, D].forEach((id) => { const c = room.viewFor(id).pool.find((x) => x.canVote); room.vote(id, c.answerId); });
  room.advance(A); // 結果へ
  room.startRound(A); // 次のラウンドから観戦
  assert.equal(room.viewFor(D).me.spectator, true);
  assert.equal(room.viewFor(D).me.nextSpectator, null);
});

test('観戦：観戦中の人にも出題者を任せられるが、ランダムには当たらない。出題者のまま観戦にもなれる', () => {
  const room = new Room('TEST');
  const [A, B, C, D] = ['A', 'B', 'C', 'D'].map((n, i) => room.join(null, n, i + 1).id);
  room.setSpectator(D, true);
  room.startRound(A);
  for (let i = 0; i < 30; i++) { room.randomPresenter(A); assert.notEqual(room.presenterId, D); if (room.presenterId !== A) room.reclaimRole(A); } // 主催者に戻してから、また引く
  room.setPresenter(A, D);
  assert.equal(room.presenterId, D);
  room.setPresenter(D, B);
  room.setSpectator(B, true); // 出題者が観戦になっても、出題者のまま
  assert.equal(room.presenterId, B);
  assert.ok(C);
});

test('部屋のリセット：記録・問題数・使った題材を消してロビーへ。参加者と設定は残る', () => {
  const { room, ids } = setup(3);
  const [A, B] = ids;
  toReveal(room, ids, ['ねこ', 'いぬ', 'うま']);
  room.advance(A);
  ids.forEach((id) => { const c = room.viewFor(id).pool.find((x) => x.canVote); room.vote(id, c.answerId); });
  room.advance(A); // 結果へ
  assert.equal(room.viewFor(A).history.length, 1);
  assert.throws(() => room.resetRoom(B), { code: 'not_host' });
  assert.equal(room.resetRoom(A).type, 'room_reset');
  const v = room.viewFor(A);
  assert.equal(v.phase, 'lobby');
  assert.equal(v.round, 0);
  assert.equal(v.history.length, 0);
  assert.equal(v.players.length, 3);
  assert.equal(room.usedThemes.size, 0);
  room.startRound(A); // そのまま、第1問から始められる
  assert.equal(room.viewFor(A).round, 1);
});

// ---------- 制限時間 ----------

test('制限時間：未回答がいると爆弾が爆発して、開示へ進む', () => {
  const { room, ids } = setup(3);
  const [A, B, C] = ids;
  room.setSettings(A, { timeLimit: '60' });
  assert.equal(room.settings.timeLimit, 60);
  assert.throws(() => room.setSettings(A, { timeLimit: 181 }), { code: 'bad_setting' });
  assert.throws(() => room.setSettings(A, { timeLimit: 4 }), { code: 'bad_setting' });
  room.setSettings(A, { timeLimit: 45 }); // 5〜180秒なら、どの値でもよい
  assert.equal(room.settings.timeLimit, 45);
  room.setSettings(A, { timeLimit: '60' });
  toAnswerPhase(room, ids);
  room.submitAnswer(A, 'ねこ');
  room.submitAnswer(B, 'いぬ');
  const t0 = room.answerStartedAt;
  assert.deepEqual(room.tick(t0 + 59000), []);
  const ev = room.tick(t0 + 60000);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].type, 'time_up');
  assert.equal(ev[0].bomb, true);
  assert.deepEqual(ev[0].names, ['C']);
  assert.equal(room.phase, 'reveal');
  assert.equal(room.viewFor(A).bombed, true);
  assert.equal(room.viewFor(A).pool.length, 2);
  assert.ok(C);
});

test('制限時間：全員回答済みなら爆弾なしで開示へ', () => {
  const { room, ids } = setup(3);
  room.setSettings(ids[0], { timeLimit: 30 });
  toAnswerPhase(room, ids);
  ids.forEach((id, i) => room.submitAnswer(id, ['a', 'b', 'c'][i]));
  const ev = room.tick(room.answerStartedAt + 30000);
  assert.equal(ev[0].bomb, false);
  assert.equal(room.phase, 'reveal');
  assert.equal(room.viewFor(ids[0]).bombed, false);
});

test('制限時間：回答が一つもなければ全員不正解で、次のラウンドへ進める', () => {
  const { room, ids } = setup(3);
  room.setSettings(ids[0], { timeLimit: 30 });
  toAnswerPhase(room, ids);
  const ev = room.tick(room.answerStartedAt + 31000);
  assert.equal(ev[0].noAnswer, true);
  assert.equal(room.phase, 'result');
  const v = room.viewFor(ids[1]);
  assert.equal(v.result.noAnswer, true);
  assert.deepEqual(v.result.winners, []);
  assert.equal(v.history[0].entries.length, 0); // 履歴にも、空のラウンドが入ってエラーにならない
  room.startRound(ids[0]); // 次のラウンドへ
  assert.equal(room.phase, 'topic');
  assert.equal(room.viewFor(ids[0]).bombed, false);
  assert.equal(room.viewFor(ids[0]).history.length, 1);
});

test('制限なしなら、時間が過ぎても進まない／回答ゼロでも手動で進める', () => {
  const { room, ids } = setup(3);
  toAnswerPhase(room, ids);
  assert.deepEqual(room.tick(room.answerStartedAt + 10 ** 9), []);
  assert.equal(room.phase, 'answer');
  room.advance(ids[0], { force: true });
  assert.equal(room.phase, 'result');
  assert.equal(room.viewFor(ids[0]).result.noAnswer, true);
});

test('選ぶ人に、観戦中の人を指名できる', () => {
  const { room, ids } = setup(4);
  const [A, B, C, W] = ids;
  room.setSettings(A, { chooserMode: 'one' });
  room.setSpectator(W, true);
  toAnswerPhase(room, ids);
  room.submitAnswer(A, 'a'); room.submitAnswer(B, 'b'); room.submitAnswer(C, 'c');
  room.advance(A);
  room.revealAll(A);
  room.advance(A);
  assert.equal(room.phase, 'vote');
  room.setChooser(A, W);
  assert.equal(room.chooserId, W);
  const v = room.viewFor(W);
  assert.equal(v.me.isChooser, true);
  assert.ok(v.pool.some((c) => c.canVote));
  const pick = v.pool.find((c) => c.canVote);
  room.choose(W, pick.answerId);
  assert.throws(() => room.vote(W, pick.answerId), { code: 'spectating' });
  room.advance(W);
  assert.equal(room.phase, 'result');
  assert.equal(room.viewFor(A).result.winners.length, 1);
});

test('表示名は200文字まで。同名のときは、末尾に番号が付く（200文字に収まる）', () => {
  const room = new Room('TEST');
  const long = 'あ'.repeat(200);
  const A = room.join(null, long, 1).id;
  assert.equal(room.viewFor(A).me.name.length, 200);
  assert.throws(() => room.rename(A, 'あ'.repeat(201)), { code: 'bad_name' });
  const B = room.join(null, long, 2).id;
  const nb = room.viewFor(B).me.name;
  assert.equal(nb.length, 200);
  assert.ok(nb.endsWith('2'));
});

test('退出：主催者は、ほかに接続中の人がいるうちは、先に譲渡が必要', () => {
  const { room, ids } = setup(3);
  const [host, B, C] = ids;
  assert.throws(() => room.leave(host), (e) => e.code === 'transfer_first');
  assert.equal(room.players.get(host).connected, true); // 失敗したら、何も変わらない
  room.leave(B); // 一般参加者は、そのまま退出できる
  assert.equal(room.players.get(B).connected, false);
  room.disconnect(C);
  room.leave(host); // 接続中の人が、ほかにいなければ、主催者も退出できる
  assert.equal(room.players.get(host).connected, false);
});

test('退出：譲渡したあとの元主催者は、退出できる', () => {
  const { room, ids } = setup(3);
  const [host, B] = ids;
  room.transferHost(host, B);
  room.leave(host);
  assert.equal(room.players.get(host).connected, false);
  assert.throws(() => room.leave(B), (e) => e.code === 'transfer_first'); // 新しい主催者には、同じ決まり
});

test('接続中の人数と、表示名の引き方', () => {
  const { room, ids } = setup(3);
  const [host, B, C] = ids;
  assert.equal(room.connectedCount(), 3);
  room.disconnect(B);
  assert.equal(room.connectedCount(), 2);
  room.removePlayer(host, C); // 削除された人は、数えない
  assert.equal(room.connectedCount(), 1);
  assert.equal(room.playerName(C), 'C'); // 名前は、削除された人も引ける
  assert.equal(room.playerName('nobody'), undefined);
});
