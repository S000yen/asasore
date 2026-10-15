import test from 'node:test';
import assert from 'node:assert/strict';
import { Hub, send } from './hub.js';

// 偽の接続。送られたものは sent に、閉じられたかは closed に残る。
function fakeWs(readyState = 1) {
  return {
    readyState,
    sent: [],
    closed: false,
    send(raw) { this.sent.push(JSON.parse(raw)); },
    close() { this.closed = true; },
    of(type) { return this.sent.filter((m) => m.t === type); },
    last(type) { return this.of(type).at(-1); },
  };
}

// 部屋を作り、n人を入室・接続させる。people[0] が主催者。
function setup(n = 3, { name = 'ホスト', settings } = {}) {
  const hub = new Hub();
  const { code, entry, player } = hub.createRoom(name, settings);
  const people = [{ id: player.id, ws: fakeWs(), name }];
  hub.attach(entry, player.id, people[0].ws);
  for (let i = 1; i < n; i++) {
    const p = entry.room.join(null, `P${i}`, 1000 + i);
    const ws = fakeWs();
    hub.attach(entry, p.id, ws);
    people.push({ id: p.id, ws, name: `P${i}` });
  }
  return { hub, code, entry, room: entry.room, people };
}

const clear = (people) => people.forEach((p) => { p.ws.sent.length = 0; });

test('send：切れている接続には送らない', () => {
  const open = fakeWs(1);
  const closing = fakeWs(2);
  send(open, { t: 'x' });
  send(closing, { t: 'x' });
  assert.equal(open.sent.length, 1);
  assert.equal(closing.sent.length, 0);
});

test('newCode：4文字で、紛らわしい文字（I, O, 0, 1）を含まず、重ならない', () => {
  const hub = new Hub();
  const codes = new Set();
  for (let i = 0; i < 300; i++) {
    const { code } = hub.createRoom('x');
    assert.match(code, /^[A-HJ-NP-Z2-9]{4}$/);
    codes.add(code);
  }
  assert.equal(codes.size, 300);
  assert.equal(hub.rooms.size, 300);
});

test('createRoom：作った人が主催者で、部屋が登録される', () => {
  const { hub, code, entry, room, people } = setup(1, { name: 'あや' });
  assert.equal(hub.get(code), entry);
  assert.equal(hub.rooms.get(code), entry);
  assert.equal(room.code, code);
  assert.equal(room.hostId, people[0].id);
  assert.equal(room.playerName(people[0].id), 'あや');
  assert.equal(hub.get('ZZZZ'), undefined);
});

test('createRoom：作成前に選んだ設定が反映される。不正な設定や、設定なしは既定のまま', () => {
  const ok = setup(1, { settings: { presenterMode: 'rotation', identityMode: 'anonymous', chooserMode: 'one', timeLimit: 30 } });
  assert.deepEqual(
    { ...ok.room.settings, order: undefined },
    { presenterMode: 'rotation', identityMode: 'anonymous', chooserMode: 'one', timeLimit: 30, order: undefined },
  );
  const defaults = { presenterMode: 'host', identityMode: 'named', chooserMode: 'all', timeLimit: 0 };
  for (const settings of [undefined, null, 'text', 42, { identityMode: 'bogus' }, { timeLimit: 9999 }, { presenterMode: 'bogus' }]) {
    const { room } = setup(1, { settings });
    assert.deepEqual({ ...room.settings, order: undefined }, { ...defaults, order: undefined }, JSON.stringify(settings));
  }
});

test('broadcast：参加者ごとに、その人用のビューが届く（同じ人の複数の画面にも）', () => {
  const { hub, entry, people } = setup(3);
  const second = fakeWs();
  hub.attach(entry, people[1].id, second); // 同じ人の2つ目の画面
  hub.broadcast(entry);
  for (const p of people) assert.equal(p.ws.last('state').view.me.id, p.id);
  assert.equal(second.last('state').view.me.id, people[1].id);
  assert.equal(people[0].ws.last('state').view.me.isHost, true);
  assert.equal(people[1].ws.last('state').view.me.isHost, false);
});

test('broadcast：切れている接続には送らない', () => {
  const { hub, entry, people } = setup(2);
  const dead = fakeWs(3);
  hub.attach(entry, people[1].id, dead);
  hub.broadcast(entry);
  assert.equal(dead.sent.length, 0);
  assert.equal(people[1].ws.of('state').length, 1);
});

test('broadcast：外された人には removed を送り、接続を閉じて、登録を外す', () => {
  const { hub, entry, room, people } = setup(3);
  const second = fakeWs();
  hub.attach(entry, people[2].id, second);
  room.removePlayer(people[0].id, people[2].id);
  hub.broadcast(entry);
  for (const ws of [people[2].ws, second]) {
    assert.equal(ws.last('removed').t, 'removed');
    assert.equal(ws.closed, true);
    assert.equal(ws.of('state').length, 0);
  }
  assert.equal(entry.sockets.has(people[2].id), false);
  assert.equal(people[1].ws.last('state').view.players.some((p) => p.id === people[2].id), false); // ほかの人の画面からも消える
});

// 匿名モードで、回答が開示される前に、他人の回答と作者が漏れないこと
test('broadcast：匿名モードでは、開示前の回答と、結果までの作者が他人に漏れない', () => {
  const { hub, entry, room, people } = setup(3, { settings: { identityMode: 'anonymous' } });
  const [host, a, b] = people;
  room.startRound(host.id);
  room.setTopic(host.id, { hiragana: 'あ', theme: 'テスト' });
  room.confirmTopic(host.id);
  const secrets = { [host.id]: '主催者の秘密の答え', [a.id]: 'Aの秘密の答え', [b.id]: 'Bの秘密の答え' };
  for (const p of people) room.submitAnswer(p.id, secrets[p.id]);
  room.advance(host.id, { force: true });
  assert.equal(room.phase, 'reveal');

  clear(people);
  hub.broadcast(entry);
  const seen = (p) => JSON.stringify(p.ws.sent);
  // 自分の回答は見える。他人の回答は、開示されるまで、どこにも出てこない
  assert.ok(seen(a).includes(secrets[a.id]));
  assert.ok(!seen(a).includes(secrets[b.id]) && !seen(a).includes(secrets[host.id]));
  assert.ok(!seen(b).includes(secrets[a.id]) && !seen(b).includes(secrets[host.id]));
  // 主催者にも、匿名の間は、ほかの人の回答の中身は伏せられる（自分の回答は見える）
  assert.ok(seen(host).includes(secrets[host.id]));
  assert.ok(!seen(host).includes(secrets[a.id]) && !seen(host).includes(secrets[b.id]));

  // 全部開示して投票へ：回答の中身は見えるが、作者は誰にも出ない
  room.revealAll(host.id);
  room.advance(host.id, { force: true });
  assert.equal(room.phase, 'vote');
  clear(people);
  hub.broadcast(entry);
  for (const p of people) {
    const view = p.ws.last('state').view;
    assert.ok(view.pool.length === 3 && view.pool.every((c) => c.revealed && c.author === null), 'pool');
    assert.ok(view.answers.every((c) => c.author === null), 'answers');
  }

  // 投票を終えて結果へ：結果発表のあとは、作者が出る
  for (const p of people) {
    const cell = room.viewFor(p.id).pool.find((c) => c.canVote);
    room.vote(p.id, cell.answerId);
  }
  room.advance(host.id, { force: true });
  assert.equal(room.phase, 'result');
  clear(people);
  hub.broadcast(entry);
  const result = a.ws.last('state').view.result;
  assert.deepEqual(result.tallies.map((t) => t.author).sort(), ['P1', 'P2', 'ホスト']);
});

test('notifyAll：全員の全ての画面に、通知が届く', () => {
  const { hub, entry, people } = setup(3);
  const second = fakeWs();
  hub.attach(entry, people[0].id, second);
  hub.notifyAll(entry, 'こんにちは');
  for (const ws of [...people.map((p) => p.ws), second]) assert.deepEqual(ws.sent, [{ t: 'notice', text: 'こんにちは' }]);
});

test('announce：イベントを通知文にして出す。通知のないイベントは何も出さない', () => {
  const { hub, entry, room, people } = setup(3);
  hub.announce(entry, room.transferHost(people[0].id, people[1].id));
  for (const p of people) assert.deepEqual(p.ws.sent, [{ t: 'notice', text: 'P1さんが主催者になりました' }]);
  clear(people);
  hub.announce(entry, { type: 'spectator_pending', id: people[0].id, spectator: true });
  hub.announce(entry, undefined);
  hub.announce(entry, null);
  for (const p of people) assert.deepEqual(p.ws.sent, []);
});

test('sendReact：全員に反応が流れる（状態は送らない）', () => {
  const { hub, entry, people } = setup(3);
  hub.sendReact(entry, 'like');
  for (const p of people) assert.deepEqual(p.ws.sent, [{ t: 'react', kind: 'like' }]);
});

test('closeRoom：全員に closed を送り、一覧から外す', () => {
  const { hub, code, entry, people } = setup(3);
  hub.closeRoom(code, entry);
  for (const p of people) assert.deepEqual(p.ws.sent, [{ t: 'closed' }]);
  assert.equal(hub.get(code), undefined);
  assert.equal(hub.rooms.size, 0);
});

test('leave：その人の画面を全部閉じて left を送り、ほかの人には最新の状態を送る', () => {
  const { hub, entry, room, people } = setup(3);
  const second = fakeWs();
  hub.attach(entry, people[2].id, second);
  room.leave(people[2].id); // 部屋の側の処理は、呼び出し側が済ませておく
  clear(people);
  hub.leave(entry, people[2].id);
  for (const ws of [people[2].ws, second]) {
    assert.deepEqual(ws.sent, [{ t: 'left' }]);
    assert.equal(ws.closed, true);
  }
  assert.equal(entry.sockets.has(people[2].id), false);
  const view = people[1].ws.last('state').view;
  assert.equal(view.players.find((p) => p.id === people[2].id).connected, false);
  assert.equal(people[0].ws.closed, false);
});

test('detach：同じ人の別の画面が残っていれば、そのまま。全部なくなったら離席にして知らせる', () => {
  const { hub, entry, room, people } = setup(3);
  const second = fakeWs();
  hub.attach(entry, people[1].id, second);
  clear(people);
  hub.detach(entry, people[1].id, people[1].ws); // 1つ目が切れた
  assert.equal(room.players.get(people[1].id).connected, true);
  assert.equal(people[0].ws.sent.length, 0); // 誰にも何も送らない
  hub.detach(entry, people[1].id, second); // 最後の画面が切れた
  assert.equal(room.players.get(people[1].id).connected, false);
  assert.equal(entry.sockets.has(people[1].id), false);
  const view = people[0].ws.last('state').view;
  assert.equal(view.players.find((p) => p.id === people[1].id).connected, false);
});

test('detach：登録のない接続は無視する', () => {
  const { hub, entry, people } = setup(2);
  clear(people);
  hub.detach(entry, 'nobody', fakeWs());
  hub.detach(entry, people[1].id, fakeWs()); // この人の登録にない接続
  assert.equal(entry.room.players.get(people[1].id).connected, true);
  assert.equal(people[0].ws.sent.length, 0);
});

test('tick：何も起きなければ、何も送らない', () => {
  const { hub, people } = setup(3);
  clear(people);
  hub.tick();
  for (const p of people) assert.deepEqual(p.ws.sent, []);
});

test('tick：主催者が猶予を過ぎて不在なら、引き継ぎを通知し、新しい状態を送る', () => {
  const { hub, entry, room, people } = setup(3);
  hub.detach(entry, people[0].id, people[0].ws); // 主催者が切れた
  room.players.get(people[0].id).disconnectedAt = 0; // 猶予（3分）はとうに過ぎた
  clear(people);
  hub.tick();
  assert.equal(room.hostId, people[1].id);
  assert.equal(people[1].ws.of('notice')[0].text, '主催者が不在のため、P1さんが主催者になりました');
  assert.equal(people[2].ws.of('notice').length, 1);
  assert.equal(people[1].ws.last('state').view.me.isHost, true);
  assert.equal(people[0].ws.sent.length, 0); // 切れた人には、もう送る先がない
});

test('tick：誰もいないまま時間が過ぎた部屋は、閉じて一覧から外す', () => {
  const { hub, code, entry, room, people } = setup(2);
  const stay = fakeWs();
  for (const p of people) hub.detach(entry, p.id, p.ws);
  hub.attach(entry, people[0].id, stay); // 通知先の確認用に、登録だけ残しておく（部屋の側は離席のまま）
  for (const p of room.players.values()) p.disconnectedAt = 0;
  room.createdAt = 0;
  hub.tick();
  assert.equal(room.closed, true);
  assert.equal(hub.get(code), undefined);
  assert.deepEqual(stay.sent, [{ t: 'closed' }]);
});

test('tick：複数の部屋を、それぞれ別に扱う', () => {
  const a = setup(3);
  const b = setup(3);
  const hub = new Hub();
  hub.rooms.set('AAAA', a.entry);
  hub.rooms.set('BBBB', b.entry);
  a.hub.detach(a.entry, a.people[0].id, a.people[0].ws);
  a.room.players.get(a.people[0].id).disconnectedAt = 0;
  clear(a.people);
  clear(b.people);
  hub.tick();
  assert.equal(a.room.hostId, a.people[1].id);
  assert.equal(b.room.hostId, b.people[0].id);
  for (const p of b.people) assert.deepEqual(p.ws.sent, []); // 別の部屋には何も届かない
});
