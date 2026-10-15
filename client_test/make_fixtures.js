// 画面の HTML のテストに使う入力データ（fixtures.json）を作る。
//   使い方: node client_test/make_fixtures.js
//
// 本物の Room を動かして、フェーズ（ロビー〜結果）× 役割（主催者・一般・観戦）× モード（記名/匿名・全員/一人）の
// ビュー（サーバーが各参加者に送る viewFor の結果）を集め、画面の状態（シート・確認ダイアログなど）を組み合わせたシナリオにする。
// サーバーが送るビューの形が変わったとき以外は、作り直さなくてよい。（作り直したら、golden も作り直して、差分を確かめること）

import crypto from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

let uuid = 0, rnd = 3;
crypto.randomUUID = () => `id-${String(++uuid).padStart(4, '0')}`;
crypto.randomInt = (...a) => { rnd = (rnd * 1103515245 + 12345) % 2147483648; const n = a.length === 2 ? a[1] - a[0] : a[0]; return (a.length === 2 ? a[0] : 0) + (rnd % n); };
syncBuiltinESMExports();
let clock = 1_700_000_000_000;
Date.now = () => clock;

const { Room } = await import('../server/room.js');

const views = {};     // 名前 -> ビュー
const scenarios = []; // { name, fn, view, ui, drafts, state, newRoom, howto }

const ROLES = ['host', 'a', 'b', 'c', 'spec'];
const VIEWERS = ['host', 'a', 'spec']; // 主催者・一般・観戦。b と c は、一覧に出る名前の確認用（長い名前、記号入りの名前）

function makeRoom(settings = {}) {
  const room = new Room('ABCD', { graceMs: 1000, emptyCloseMs: 1000, now: clock });
  const ids = {
    host: room.join(null, 'ホスト', 1000).id,
    a: room.join(null, 'アヤ', 1001).id,
    b: room.join(null, '<ボブ>&"\'', 1002).id, // 記号は、画面で文字として出る
    c: room.join(null, 'とてもとてもながいなまえのひとがここにいます', 1003).id, // 長い名前
    spec: room.join(null, 'ミケ', 1004, { spectator: true }).id,
  };
  if (Object.keys(settings).length) room.setSettings(ids.host, settings);
  return { room, ids };
}

function addViews(mode, label, room, ids, viewers = VIEWERS) {
  for (const role of viewers) {
    const name = `${mode}/${label}/${role}`;
    views[name] = room.viewFor(ids[role]);
    scenarios.push({ name, fn: 'roomHtml', view: name, ui: { connected: true } });
  }
}

const pool = (room, id) => room.viewFor(id).pool;
const ANSWERS = { a: 'ごはん', host: 'パン', b: '<script>alert(1)</script>', c: 'とてもとてもとてもながいこたえがはいりますよろしくおねがいします' };

function submitAll(room, ids, who = ['a', 'host', 'b', 'c']) {
  for (const role of who) room.submitAnswer(ids[role], ANSWERS[role]);
}

// 開示：記名なら本人が、匿名なら主催者が、1つずつ
function revealSome(room, ids, anon) {
  if (anon) room.revealSelected(ids.host, room.viewFor(ids.host).unrevealed[0].answerId);
  else { room.revealOwn(ids.a); room.revealOwn(ids.host); }
}

// 投票（または一人が選ぶ）を、全員分すませる
function voteAll(room, ids, one) {
  if (one) {
    const chooser = room.chooserId;
    room.choose(chooser, room.viewFor(chooser).pool.find((c) => c.canVote).answerId);
    return;
  }
  for (const role of ['host', 'a', 'b', 'c']) {
    const cell = pool(room, ids[role]).find((c) => c.canVote);
    if (cell) room.vote(ids[role], cell.answerId);
  }
}

// ---------- モードごとに、2ラウンドを通して集める ----------

const MODES = [
  ['named-all', { identityMode: 'named', chooserMode: 'all' }],
  ['anon-all', { identityMode: 'anonymous', chooserMode: 'all', timeLimit: 60 }],
  ['named-one', { identityMode: 'named', chooserMode: 'one', presenterMode: 'rotation' }],
  ['anon-one', { identityMode: 'anonymous', chooserMode: 'one' }],
];

for (const [mode, settings] of MODES) {
  const { room, ids } = makeRoom(settings);
  const anon = settings.identityMode === 'anonymous';
  const one = settings.chooserMode === 'one';
  const snap = (label, viewers) => addViews(mode, label, room, ids, viewers);

  snap('r0-lobby', ROLES); // ロビーは、全員分（名前の見え方の確認）

  // ラウンド1
  room.startRound(ids.host);
  snap('r1-topic-empty');
  const presenter = room.presenterId;
  room.setTopic(presenter, { hiragana: 'あ', theme: '朝ごはんに食べたいもの' });
  snap('r1-topic-draft');
  room.confirmTopic(presenter);
  room.submitAnswer(ids.a, ANSWERS.a); // 1人だけ回答済み
  clock += 65_000;
  snap('r1-answer-partial');
  submitAll(room, ids, ['host', 'b', 'c']);
  room.advance(ids.host, { force: true });
  snap('r1-reveal-0');
  revealSome(room, ids, anon);
  snap('r1-reveal-partial');
  room.revealAll(ids.host);
  room.group(ids.host, pool(room, ids.host).slice(0, 2).map((c) => c.answerId)); // 先頭の2つを「同じ回答」にまとめる
  snap('r1-reveal-grouped');
  room.advance(ids.host, { force: true });
  snap('r1-vote-0');
  if (one) {
    room.setChooser(ids.host, ids.a);
    snap('r1-vote-chooser-a');
    room.choose(ids.a, pool(room, ids.a).find((c) => c.canVote).answerId);
    snap('r1-vote-chosen');
    room.advance(ids.a, { force: true });
  } else {
    for (const role of ['host', 'a']) room.vote(ids[role], pool(room, ids[role]).find((c) => c.canVote).answerId);
    snap('r1-vote-partial');
    voteAll(room, ids, false);
    room.advance(ids.host, { force: true });
  }
  snap('r1-result');

  // ラウンド2（記録を2件にする）
  room.startRound(ids.host);
  snap('r2-topic-empty');
  const presenter2 = room.presenterId;
  room.setTopic(presenter2, { hiragana: 'さ', theme: '休みの日にしたいこと' });
  room.confirmTopic(presenter2);
  submitAll(room, ids);
  room.advance(ids.host, { force: true });
  room.revealAll(ids.host);
  room.advance(ids.host, { force: true });
  voteAll(room, ids, one);
  room.advance(one ? room.chooserId : ids.host, { force: true });
  snap('r2-result');
}

// ---------- 特別な場面（記名・全員投票のモードで） ----------

const NAMED = { identityMode: 'named', chooserMode: 'all' };
{ // 離席中の人がいるロビー
  const { room, ids } = makeRoom(NAMED);
  room.disconnect(ids.b, clock);
  room.disconnect(ids.c, clock);
  addViews('extra', 'lobby-away', room, ids, ['host', 'a']);
}
{ // 外した人がいる（主催者にだけ一覧が出る）
  const { room, ids } = makeRoom(NAMED);
  room.removePlayer(ids.host, ids.b);
  addViews('extra', 'lobby-removed', room, ids, ['host', 'a']);
}
{ // 同票
  const { room, ids } = makeRoom(NAMED);
  room.startRound(ids.host);
  room.setTopic(ids.host, { hiragana: 'あ', theme: '同票になるお題' });
  room.confirmTopic(ids.host);
  submitAll(room, ids);
  room.advance(ids.host, { force: true });
  room.revealAll(ids.host);
  room.advance(ids.host, { force: true });
  const mine = (role) => room.answers.get(ids[role]).id;
  room.vote(ids.host, mine('a')); room.vote(ids.a, mine('host')); room.vote(ids.b, mine('a')); room.vote(ids.c, mine('host'));
  room.advance(ids.host, { force: true });
  addViews('extra', 'tie-result', room, ids, ['host', 'a']);
}
{ // 誰も答えなかった
  const { room, ids } = makeRoom(NAMED);
  room.startRound(ids.host);
  room.setTopic(ids.host, { hiragana: 'あ', theme: '誰も答えないお題' });
  room.confirmTopic(ids.host);
  room.advance(ids.host, { force: true });
  addViews('extra', 'noanswer-result', room, ids, ['host']);
}
{ // 開示のあとで、観戦への切り替えを頼んだ（次のラウンドから）
  const { room, ids } = makeRoom(NAMED);
  room.startRound(ids.host);
  room.setTopic(ids.host, { hiragana: 'あ', theme: '観戦を頼むお題' });
  room.confirmTopic(ids.host);
  submitAll(room, ids);
  room.advance(ids.host, { force: true });
  room.setSpectator(ids.a, true);
  addViews('extra', 'reveal-spectate-pending', room, ids, ['a', 'host']);
}

{ // 長さの境目をまたぐ名前（10/11・12/13・14/15・16/17・17/18・20/21・24/25 文字）と回答（8/9・10/11・22/23 文字）
  const nm = (n) => [...`${n}あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほ`].slice(0, n).join('');
  const lens = [17, 10, 16, 11, 12, 13, 14, 15, 18, 20, 21, 24, 25]; // 先頭から、主催者・a・b、そのほか
  const room = new Room('ABCD', { graceMs: 1000, emptyCloseMs: 1000, now: clock });
  const all = lens.map((n, i) => room.join(null, nm(n), 2000 + i).id);
  const ids = { host: all[0], a: all[1], b: all[2] };
  room.setSettings(ids.host, { identityMode: 'named', chooserMode: 'all', presenterMode: 'rotation' });
  const snap = (label, viewers) => addViews('names', label, room, ids, viewers);
  const ans = (n) => [...`${n}ーーーーーーーーーーーーーーーーーーーーーーーーーーーーーーーー`].slice(0, n).join('');
  const answerLens = [8, 9, 10, 11, 22, 23, 5, 12, 24, 30, 1, 15, 16];
  snap('lobby', ['host', 'a', 'b']);
  room.startRound(ids.host);
  room.setTopic(room.presenterId, { hiragana: 'あ', theme: 'ながいだいざいがここにはいりますよろしくおねがいします。'.slice(0, 40) });
  room.confirmTopic(room.presenterId);
  all.slice(0, 5).forEach((id, i) => room.submitAnswer(id, ans(answerLens[i])));
  clock += 20_000;
  snap('answer-partial', ['host']);
  all.slice(5).forEach((id, i) => room.submitAnswer(id, ans(answerLens[i + 5])));
  room.advance(ids.host, { force: true });
  room.revealAll(ids.host);
  snap('reveal', ['host', 'a']);
  room.advance(ids.host, { force: true });
  all.slice(0, 6).forEach((id) => room.vote(id, room.viewFor(id).pool.find((c) => c.canVote).answerId));
  snap('vote-partial', ['host']);
  all.slice(6).forEach((id) => room.vote(id, room.viewFor(id).pool.find((c) => c.canVote).answerId));
  room.advance(ids.host, { force: true });
  snap('result', ['host', 'a']);
}

// ---------- 画面の状態を組み合わせたシナリオ ----------

const N = (stage, role) => `named-all/${stage}/${role}`;
const revealedIds = (name) => views[name].pool.filter((c) => c.revealed).map((c) => c.answerId);
const variant = (name, base, { ui = {}, drafts, howto, viewPatch } = {}) => {
  if (!views[base]) throw new Error(`ビューがありません: ${base}`);
  scenarios.push({ name: `variant/${name}`, fn: 'roomHtml', view: base, viewPatch, ui: { connected: true, ...ui }, drafts, howto });
};
const menu = { sheet: { kind: 'menu' } };
const sheet = (kind) => ({ sheet: { kind } });

variant('conn-lost', N('r1-answer-partial', 'host'), { ui: { connected: false } });
variant('toast', N('r0-lobby', 'host'), { ui: { toast: '次のラウンドから観戦になります' } });

// メニュー：主催者・一般・観戦・役割の回収・観戦の予約
variant('menu-host-lobby', N('r0-lobby', 'host'), { ui: menu });
variant('menu-host-nohistory-reset-enabled', N('r2-result', 'host'), { ui: menu });
variant('menu-guest', N('r0-lobby', 'a'), { ui: menu });
variant('menu-spectator', N('r0-lobby', 'spec'), { ui: menu });
variant('menu-host-reclaim-chooser', 'named-one/r1-vote-chooser-a/host', { ui: menu });
variant('menu-host-reclaim-presenter', 'named-one/r2-topic-empty/host', { ui: menu });
variant('menu-spectate-pending', 'extra/reveal-spectate-pending/a', { ui: menu });
variant('menu-host-with-removed', 'extra/lobby-removed/host', { ui: menu });

// 各シート
variant('sheet-history', N('r2-result', 'host'), { ui: sheet('history') });
variant('sheet-history-empty', N('r0-lobby', 'host'), { ui: sheet('history') });
variant('sheet-settings-lobby', N('r0-lobby', 'host'), { ui: sheet('settings') });
variant('sheet-settings-locked', N('r1-answer-partial', 'host'), { ui: sheet('settings') });
variant('sheet-settings-rotation', 'named-one/r0-lobby/host', { ui: sheet('settings') });
variant('sheet-rename', N('r0-lobby', 'host'), { ui: sheet('rename'), drafts: { rename: 'あたらしいなまえ' } });
variant('sheet-players-host', N('r0-lobby', 'host'), { ui: sheet('players') });
variant('sheet-players-guest', N('r0-lobby', 'a'), { ui: sheet('players') });
variant('sheet-transfer', N('r0-lobby', 'host'), { ui: sheet('transfer') });
variant('sheet-allow', 'extra/lobby-removed/host', { ui: sheet('allow') });
variant('sheet-presenter', N('r1-topic-empty', 'host'), { ui: sheet('presenter') });
variant('sheet-chooser', 'named-one/r1-vote-chooser-a/a', { ui: sheet('chooser') });
variant('sheet-howto', N('r0-lobby', 'host'), { ui: sheet('howto'), howto: true });
variant('sheet-howto-loading', N('r0-lobby', 'host'), { ui: sheet('howto') });

// 確認ダイアログ
variant('modal-confirm', N('r1-answer-partial', 'host'), { ui: { modal: { body: 'まだ3人が未回答です（ホスト、<ボブ>、ミケ）。このまま進みますか？', ok: '進める' } } });
variant('modal-quote', N('r1-vote-partial', 'host'), { ui: { modal: { quote: 'ごはん', ok: '投票する' } } });
variant('modal-danger', N('r0-lobby', 'host'), { ui: { modal: { body: 'ミケさんを部屋から外します。許可するまで、入り直せなくなります。', ok: '外す', danger: true } } });

// 入力中の内容（下書き）
variant('draft-topic', N('r1-topic-draft', 'host'), { drafts: { hiragana: 'さ', theme: '書き換えている途中の題材' } });
variant('draft-answer-unanswered', N('r1-answer-partial', 'host'), { drafts: { answer: 'かきかけのこたえ' } });
variant('draft-answer-answered', N('r1-answer-partial', 'a'), { drafts: { answer: 'ごはん' } });

// まとめの編集中
variant('editing-reveal', N('r1-reveal-grouped', 'host'), { ui: { editing: true, sel: revealedIds(N('r1-reveal-grouped', 'host')).slice(1, 3) } });
variant('editing-vote', N('r1-vote-partial', 'host'), { ui: { editing: true, sel: revealedIds(N('r1-vote-partial', 'host')).slice(0, 2) } });
variant('editing-none-selected', N('r1-reveal-grouped', 'host'), { ui: { editing: true } });

// 名前・回答の長さの境目
variant('names-menu-host', 'names/lobby/host', { ui: menu });
variant('names-menu-a', 'names/lobby/a', { ui: menu });
variant('names-menu-b', 'names/lobby/b', { ui: menu });
variant('names-players', 'names/lobby/host', { ui: sheet('players') });
variant('names-transfer', 'names/lobby/host', { ui: sheet('transfer') });
variant('names-settings-rotation', 'names/lobby/host', { ui: sheet('settings') });
variant('names-history', 'names/result/host', { ui: sheet('history') });

// 回答待ちの時計：制限なし（経過）と、制限あり（残り。10秒以下で警告）
for (const sec of [0, 59, 60, 3725]) variant(`timer-nolimit-${sec}`, N('r1-answer-partial', 'host'), { viewPatch: { answerSec: sec } });
for (const sec of [0, 49, 50, 51, 60, 75]) variant(`timer-limit60-${sec}`, 'anon-all/r1-answer-partial/host', { viewPatch: { answerSec: sec } });

// ---------- 入室前の画面 ----------

const entry = (name, { ui = {}, drafts, state, newRoom } = {}) => scenarios.push({ name: `entry/${name}`, fn: 'entryHtml', view: null, ui: { connected: true, ...ui }, drafts, state, newRoom });
entry('default');
entry('disconnected', { ui: { connected: false } });
entry('create-dialog', { ui: { createOpen: true } });
entry('create-dialog-custom', { ui: { createOpen: true }, newRoom: { presenterMode: 'rotation', identityMode: 'anonymous', chooserMode: 'one', timeLimit: 45 } });
entry('create-dialog-nolimit', { ui: { createOpen: true }, newRoom: { timeLimit: 0 } });
entry('join-dialog', { ui: { joinOpen: true }, drafts: { code: 'AB' } });
entry('join-dialog-watch', { ui: { joinOpen: true, joinWatch: true }, drafts: { code: 'ABCD' } });
entry('joining', { ui: { joining: true } });
entry('resume-link', { state: { session: { code: 'ABCD', playerId: 'p1' } } });
entry('end-banned', { state: { session: { code: 'ABCD', playerId: 'p1' }, endMessage: { title: 'この部屋には入れません', body: '主催者が再入室を許可すると、もう一度入れます。', retry: true } } });
entry('end-removed', { state: { endMessage: { title: '部屋から外されました', body: '主催者が再入室を許可すると、もう一度入れます。', retry: true } } });
entry('end-closed', { state: { endMessage: { title: '部屋が閉じられました', body: '' } } });
entry('end-with-toast', { ui: { toast: 'その部屋は見つかりません' }, state: { endMessage: { title: '部屋が閉じられました', body: '' } } });

// ---------- 書き出し ----------

const names = scenarios.map((s) => s.name);
if (new Set(names).size !== names.length) throw new Error('シナリオの名前が重なっています');
const out = fileURLToPath(new URL('./fixtures.json', import.meta.url));
// 1シナリオ・1ビューにつき1行で書く（差分が読めるように）
const lines = [
  '{',
  '"views": {',
  Object.entries(views).map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(',\n'),
  '},',
  '"scenarios": [',
  scenarios.map((s) => JSON.stringify(s)).join(',\n'),
  ']',
  '}',
  '',
];
fs.writeFileSync(out, lines.join('\n'));
console.log(`ビュー ${Object.keys(views).length} 件、シナリオ ${scenarios.length} 件を書き出しました: ${out}`);
