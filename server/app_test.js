// 本物の HTTP / WebSocket を、空きポートで起動して通しで確かめる。
import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { createApp } from './app.js';
import { pingClients } from './net/socket.js';
import { TopicPool } from './data/topics.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 2000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('条件が満たされませんでした');
    await sleep(10);
  }
}

async function start(t, opts = {}) {
  const topics = new TopicPool(['A', 'B', 'C']);
  const app = createApp({ topics, adminToken: '', ...opts });
  const port = await app.listen(0);
  t.after(() => app.close());
  return { app, topics, port, url: `ws://127.0.0.1:${port}` };
}

// 届いたメッセージを順に溜めて、「このメッセージが届くまで待つ」ができる接続
class Client {
  static async open(t, url) {
    const c = new Client(new WebSocket(url));
    t.after(() => c.ws.terminate());
    await new Promise((res, rej) => { c.ws.once('open', res); c.ws.once('error', rej); });
    return c;
  }

  constructor(ws) {
    this.ws = ws;
    this.log = [];
    this.cursor = 0;
    this.waiters = [];
    this.view = null; // 最後に届いた state の view
    this.closed = new Promise((res) => ws.once('close', res));
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.t === 'state') this.view = m.view;
      this.log.push(m);
      this._flush();
    });
  }

  send(msg) { this.ws.send(JSON.stringify(msg)); }
  act(a, extra = {}) { this.send({ t: 'act', a, ...extra }); }
  mark() { this.cursor = this.log.length; } // これより前に届いたものは、待つ対象から外す

  _flush() {
    for (const w of [...this.waiters]) {
      const i = this.log.findIndex((m, idx) => idx >= this.cursor && w.pred(m));
      if (i < 0) continue;
      this.cursor = i + 1;
      this.waiters = this.waiters.filter((x) => x !== w);
      w.resolve(this.log[i]);
    }
  }

  waitFor(pred, ms = 2000) {
    return new Promise((resolve, reject) => {
      const waiter = { pred, resolve: (m) => { clearTimeout(timer); resolve(m); } };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((x) => x !== waiter);
        reject(new Error(`待っていたメッセージが届きませんでした。届いたもの: ${JSON.stringify(this.log.slice(this.cursor))}`));
      }, ms);
      this.waiters.push(waiter);
      this._flush();
    });
  }

  type(t) { return this.waitFor((m) => m.t === t); }
  async state(pred = () => true) { return (await this.waitFor((m) => m.t === 'state' && pred(m.view))).view; }
  async error() { return (await this.type('error')).code; }

  async create(name = 'ホスト', settings, extra = {}) {
    this.send({ t: 'create', name, settings, ...extra });
    return this.type('joined');
  }

  async join(code, name, extra = {}) {
    this.send({ t: 'join', code, name, ...extra });
    return this.type('joined');
  }
}

// n人が入った部屋。people[0] が主催者。各人に id が付く。
async function lobby(t, n = 3, opts) {
  const env = await start(t, opts);
  const host = await Client.open(t, env.url);
  const { code, playerId } = await host.create('ホスト');
  host.id = playerId;
  const people = [host];
  for (let i = 1; i < n; i++) {
    const c = await Client.open(t, env.url);
    c.id = (await c.join(code, `ゲスト${i}`)).playerId;
    people.push(c);
  }
  await Promise.all(people.map((c) => c.state((v) => v.players.length === n)));
  people.forEach((c) => c.mark());
  return { ...env, code, host, people, room: env.app.hub.get(code).room };
}

const allState = (people, pred) => Promise.all(people.map((c) => c.state(pred)));
const phase = (p) => (v) => v.phase === p;

// ---------- 接続と入室 ----------

test('接続すると hello が届き、版は配信している画面の版と同じ', async (t) => {
  const { url, port, app } = await start(t);
  const c = await Client.open(t, url);
  const hello = await c.type('hello');
  assert.equal(hello.build, app.build);
  const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
  assert.ok(html.includes(`<meta name="build" content="${hello.build}">`));
});

test('部屋をつくる：コードと参加者IDが届き、作った人が主催者になる', async (t) => {
  const { url } = await start(t);
  const c = await Client.open(t, url);
  const joined = await c.create('あや');
  assert.match(joined.code, /^[A-HJ-NP-Z2-9]{4}$/);
  const view = await c.state();
  assert.equal(view.code, joined.code);
  assert.equal(view.me.id, joined.playerId);
  assert.equal(view.me.isHost, true);
  assert.equal(view.me.name, 'あや');
  assert.equal(view.phase, 'lobby');
});

test('部屋をつくる：名前なしなら「ユーザー1」。作成前に選んだ設定が反映される', async (t) => {
  const { url } = await start(t);
  const c = await Client.open(t, url);
  await c.create('', { identityMode: 'anonymous', chooserMode: 'one', timeLimit: 30 });
  const view = await c.state();
  assert.equal(view.me.name, 'ユーザー1');
  assert.equal(view.settings.identityMode, 'anonymous');
  assert.equal(view.settings.chooserMode, 'one');
  assert.equal(view.settings.timeLimit, 30);
});

test('入室：コードの大文字小文字や前後の空白は問わず、全員に最新の状態が届く', async (t) => {
  const { url } = await start(t);
  const host = await Client.open(t, url);
  const { code } = await host.create('ホスト');
  await host.state();
  host.mark();
  const guest = await Client.open(t, url);
  const joined = await guest.join(` ${code.toLowerCase()} `, 'ゲスト');
  assert.equal(joined.code, code);
  const seen = await host.state((v) => v.players.length === 2);
  assert.deepEqual(seen.players.map((p) => p.name), ['ホスト', 'ゲスト']);
  const mine = await guest.state((v) => v.players.length === 2);
  assert.equal(mine.me.isHost, false);
});

test('入室：観戦で入れる', async (t) => {
  const { url } = await start(t);
  const host = await Client.open(t, url);
  const { code } = await host.create('ホスト');
  const guest = await Client.open(t, url);
  await guest.join(code, 'ゲスト', { spectator: true });
  assert.equal((await guest.state((v) => v.players.length === 2)).me.spectator, true);
});

test('入室できないとき：存在しない部屋、部屋に入る前の操作', async (t) => {
  const { url } = await start(t);
  const c = await Client.open(t, url);
  c.send({ t: 'join', code: 'ZZZZ', name: 'x' });
  assert.equal(await c.error(), 'no_room');
  c.send({ t: 'join', name: 'x' }); // コードなし
  assert.equal(await c.error(), 'no_room');
  c.act('advance');
  assert.equal(await c.error(), 'not_joined');
});

test('壊れたメッセージや、知らない種類は無視され、接続は使い続けられる', async (t) => {
  const { url } = await start(t);
  const c = await Client.open(t, url);
  c.mark();
  c.ws.send('これはJSONではない');
  c.send({ t: 'unknown' });
  c.send({});
  await sleep(100);
  assert.deepEqual(c.log.slice(c.cursor), []);
  await c.create('ホスト'); // そのあとも、普通に使える
  assert.equal((await c.state()).me.isHost, true);
});

// ---------- 操作 ----------

test('操作のエラー：権限がない、不明な操作、サーバー内部の失敗でも、接続は続く', async (t) => {
  const { people } = await lobby(t, 3);
  const [host, guest] = people;
  guest.act('advance');
  assert.equal(await guest.error(), 'not_host');
  guest.act('noSuchAction');
  assert.equal(await guest.error(), 'bad_request');

  t.mock.method(console, 'error', () => {}); // 想定外の失敗のログは、テストの出力には出さない
  host.act('setSettings', { patch: null }); // 想定外の値で、room の中で例外になる
  const err = await host.type('error');
  assert.equal(err.code, 'internal');
  assert.equal(err.message, 'サーバーでエラーが起きました');
  host.act('setSettings', { patch: { timeLimit: 60 } }); // そのあとも、使える
  assert.equal((await host.state((v) => v.settings.timeLimit === 60)).settings.timeLimit, 60);
});

test('1ラウンドを、WebSocket の操作だけで最後まで通せる', async (t) => {
  const { people, host } = await lobby(t, 3);
  host.act('advance');
  await allState(people, phase('topic'));
  host.act('drawTopic', { part: 'both' });
  host.act('confirmTopic');
  const topicSeen = await allState(people, phase('answer'));
  assert.ok(topicSeen.every((v) => v.topic?.theme)); // 確定後は、全員にお題が見える
  people.forEach((c, i) => c.act('submitAnswer', { text: `こたえ${i}` }));
  await allState(people, (v) => v.players.every((p) => p.answered));
  host.act('advance');
  await allState(people, phase('reveal'));
  people.forEach((c) => c.act('revealOwn'));
  await allState(people, (v) => v.phase === 'reveal' && v.unrevealedCount === 0);
  host.act('advance');
  await allState(people, phase('vote'));
  for (const c of people) c.act('vote', { answerId: c.view.pool.find((x) => x.canVote).answerId });
  await allState(people, (v) => v.players.every((p) => p.voted));
  host.act('advance');
  const results = await allState(people, phase('result'));
  assert.ok(results[0].result.winners.length > 0);
  assert.equal(results[0].history.length, 1);
  host.act('advance');
  const next = await allState(people, phase('topic'));
  assert.equal(next[0].round, 2);
});

test('未完了の人がいるまま進めようとすると、確認が返り、force で進む', async (t) => {
  const { people, host } = await lobby(t, 3);
  host.act('advance');
  await allState(people, phase('topic'));
  host.act('setTopic', { hiragana: 'あ', theme: 'A' });
  host.act('confirmTopic');
  await allState(people, phase('answer'));
  host.act('submitAnswer', { text: 'こたえ' });
  await host.state((v) => v.myAnswer === 'こたえ');
  host.mark();
  host.act('advance');
  const ask = await host.type('needConfirm');
  assert.equal(ask.phase, 'answer');
  assert.equal(ask.pending.count, 2);
  assert.deepEqual(ask.pending.names.sort(), ['ゲスト1', 'ゲスト2']);
  host.act('advance', { force: true });
  await allState(people, phase('reveal'));
});

test('反応マークは、全員に流れるだけで、状態は送られない', async (t) => {
  const { people, host } = await lobby(t, 3);
  host.act('advance');
  await allState(people, phase('topic'));
  host.act('setTopic', { hiragana: 'あ', theme: 'A' });
  host.act('confirmTopic');
  await allState(people, phase('answer'));
  people.forEach((c, i) => c.act('submitAnswer', { text: `こたえ${i}` }));
  await allState(people, (v) => v.players.every((p) => p.answered));
  host.act('advance');
  await allState(people, phase('reveal'));
  people.forEach((c) => c.mark());
  people[1].act('react', { kind: 'cheer' });
  for (const c of people) assert.equal((await c.type('react')).kind, 'cheer');
  await sleep(100);
  for (const c of people) assert.equal(c.log.slice(c.cursor).filter((m) => m.t === 'state').length, 0);
});

test('通知：主催者を譲ると、全員に通知が届く', async (t) => {
  const { people, host } = await lobby(t, 3);
  host.act('transferHost', { to: people[1].id });
  for (const c of people) assert.equal((await c.type('notice')).text, 'ゲスト1さんが主催者になりました');
  assert.equal((await people[1].state((v) => v.me.isHost)).me.isHost, true);
});

// 主催者が clientId を付けて部屋を作り、題決めの段階（お題は「A」）まで進める
async function reportingHost(t, clientId) {
  const env = await start(t);
  const host = await Client.open(t, env.url);
  const { code, playerId } = await host.create('ホスト', undefined, { clientId });
  const guests = [];
  for (const name of ['B', 'C']) {
    const g = await Client.open(t, env.url);
    await g.join(code, name);
    guests.push(g);
  }
  await host.state((v) => v.players.length === 3);
  host.act('advance');
  await host.state(phase('topic'));
  host.act('setTopic', { hiragana: 'あ', theme: 'A' });
  await host.state((v) => v.topic?.theme === 'A');
  return { ...env, host, hostId: playerId };
}

test('お題の報告：端末IDで数え、題材を引き直す', async (t) => {
  const { host, topics } = await reportingHost(t, 'device-aaaa1111');
  host.act('reportTopic', { theme: 'A' });
  await host.state((v) => v.topic && v.topic.theme !== 'A');
  assert.deepEqual([...topics.themes.get('A').flaggers], ['device-aaaa1111']);
});

test('お題の報告：端末IDの形が正しくなければ、参加者のIDで数える', async (t) => {
  for (const clientId of ['x', undefined, 12345]) {
    const { host, hostId, topics } = await reportingHost(t, clientId);
    host.act('reportTopic', { theme: 'A' });
    await host.state((v) => v.topic && v.topic.theme !== 'A');
    assert.deepEqual([...topics.themes.get('A').flaggers], [hostId], String(clientId));
  }
});

// ---------- 切断・再接続・退出 ----------

test('切断すると離席になり、同じ参加者IDで戻ると、同じ人として復帰する', async (t) => {
  const { url, people, code, host } = await lobby(t, 3);
  const guest = people[1];
  guest.ws.close();
  await guest.closed;
  const away = await host.state((v) => v.players.find((p) => p.id === guest.id)?.connected === false);
  assert.equal(away.players.length, 3);

  const back = await Client.open(t, url);
  const joined = await back.join(code, 'ゲスト1', { playerId: guest.id });
  assert.equal(joined.playerId, guest.id);
  const seen = await host.state((v) => v.players.find((p) => p.id === guest.id)?.connected === true);
  assert.equal(seen.players.length, 3); // 増えていない
  assert.equal((await back.state()).me.id, guest.id);
});

test('同じ人が2つの画面で開いているとき、片方が切れても離席にならない', async (t) => {
  const { url, people, code, host } = await lobby(t, 3);
  const guest = people[1];
  const second = await Client.open(t, url);
  await second.join(code, 'ゲスト1', { playerId: guest.id });
  host.mark();
  guest.ws.close();
  await guest.closed;
  await sleep(100);
  assert.equal(host.view.players.find((p) => p.id === guest.id).connected, true);
  second.ws.close();
  await second.closed;
  await host.state((v) => v.players.find((p) => p.id === guest.id).connected === false);
});

test('退出：一般参加者は退出でき、主催者は譲渡するまで退出できない', async (t) => {
  const { people, host } = await lobby(t, 3);
  const guest = people[2];
  host.act('leave');
  assert.equal(await host.error(), 'transfer_first');
  assert.equal(host.ws.readyState, WebSocket.OPEN); // 拒否されても、接続はそのまま

  guest.act('leave');
  await guest.type('left');
  await guest.closed; // サーバーが接続を閉じる
  const seen = await host.state((v) => v.players.find((p) => p.id === guest.id)?.connected === false);
  assert.equal(seen.players.length, 3);

  host.act('transferHost', { to: people[1].id });
  await host.state((v) => !v.me.isHost);
  host.act('leave'); // 譲渡したあとは、退出できる
  await host.type('left');
});

test('部屋を閉じる：全員に closed が届き、その部屋には入れなくなる。主催者以外は閉じられない', async (t) => {
  const { url, people, host, code, app } = await lobby(t, 3);
  people[1].act('closeRoom');
  assert.equal(await people[1].error(), 'not_host');
  host.act('closeRoom');
  for (const c of people) await c.type('closed');
  assert.equal(app.hub.get(code), undefined);
  const late = await Client.open(t, url);
  late.send({ t: 'join', code, name: 'おくれた人' });
  assert.equal(await late.error(), 'no_room');
});

test('外された人には removed が届いて接続が閉じ、許可されるまで戻れない', async (t) => {
  const { url, people, host, code } = await lobby(t, 3);
  const target = people[2];
  host.act('removePlayer', { to: target.id });
  await target.type('removed');
  await target.closed;
  const seen = await host.state((v) => v.players.length === 2);
  assert.deepEqual(seen.removed.map((p) => p.id), [target.id]);

  const retry = await Client.open(t, url);
  retry.send({ t: 'join', code, name: 'C', playerId: target.id });
  assert.equal(await retry.error(), 'banned');

  host.act('allowRejoin', { to: target.id });
  await host.state((v) => v.removed.length === 0);
  const again = await Client.open(t, url);
  assert.equal((await again.join(code, 'C', { playerId: target.id })).playerId, target.id);
});

// ---------- 定期処理 ----------

test('主催者が猶予を過ぎて不在なら、自動で引き継がれ、全員に通知される', async (t) => {
  const { people, host, room } = await lobby(t, 3, { tickMs: 20 });
  room.graceMs = 0; // 猶予を待たない
  host.ws.close();
  const notice = await people[1].type('notice');
  assert.equal(notice.text, '主催者が不在のため、ゲスト1さんが主催者になりました');
  assert.equal((await people[1].state((v) => v.me.isHost)).me.isHost, true);
  assert.equal((await people[2].state((v) => v.hostId === people[1].id)).hostId, people[1].id);
});

test('誰もいなくなった部屋は、時間が過ぎると閉じて、一覧から外れる', async (t) => {
  const { url, app, code, host, room } = await lobby(t, 1, { tickMs: 20 });
  room.emptyCloseMs = 0;
  host.ws.close();
  await until(() => app.hub.get(code) === undefined);
  assert.equal(room.closed, true);
  const late = await Client.open(t, url);
  late.send({ t: 'join', code, name: 'x' });
  assert.equal(await late.error(), 'no_room');
});

test('pingClients：pong が返った接続は残り、返らない接続は切る', async () => {
  const mk = (isAlive) => ({ isAlive, pinged: false, terminated: false, ping() { this.pinged = true; }, terminate() { this.terminated = true; } });
  const alive = mk(true);
  const silent = mk(false);
  pingClients({ clients: new Set([alive, silent]) });
  assert.deepEqual([alive.isAlive, alive.pinged, alive.terminated], [false, true, false]); // 次の確認までに pong が必要
  assert.deepEqual([silent.pinged, silent.terminated], [false, true]);
  pingClients({ clients: new Set([alive]) }); // pong が返らないまま、次の確認
  assert.equal(alive.terminated, true);
});

test('本物の接続は ping に pong を返すので、続けて確認しても切られない', async (t) => {
  const { url, app } = await start(t);
  const c = await Client.open(t, url);
  for (let i = 0; i < 3; i++) {
    pingClients(app.wss);
    await sleep(80);
  }
  assert.equal(c.ws.readyState, WebSocket.OPEN);
  assert.equal(app.wss.clients.size, 1);
});

test('close すると、接続が切れ、新しい接続は受け付けない', async (t) => {
  const { url, app } = await start(t);
  const c = await Client.open(t, url);
  app.close();
  await c.closed;
  await assert.rejects(Client.open(t, url));
});
