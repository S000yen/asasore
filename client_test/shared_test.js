// サーバーと画面が共有する定義（shared/）の、使われ方を守るテスト。
//  1. 画面もサーバーも、shared/ の定義を、ディスクでも URL でも、同じファイルとして読めること
//  2. ソースの中の PHASE.X のような使い方が、shared/ に実在するキーを指していること（タイプミスの防止）
//  3. フェーズ名の直書きが、shared/ の外に残っていないこと

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

function listJs(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listJs(p));
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}
const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');
const isTest = (p) => /_test\.js$/.test(p);
const read = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const stripComments = (s) => s.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');

const sharedFiles = listJs(path.join(ROOT, 'shared'));
const clientFiles = listJs(path.join(ROOT, 'public', 'js'));
const serverFiles = listJs(path.join(ROOT, 'server')).filter((f) => !isTest(f));

// shared/ が公開している、名前つきの定数オブジェクト（PHASE など）
const shared = {};
for (const f of sharedFiles) {
  const mod = await import(pathToFileURL(f).href);
  for (const [name, value] of Object.entries(mod)) if (value && typeof value === 'object' && !Array.isArray(value)) shared[name] = value;
}

test('shared/ を読む import は、画面ではディスクでも URL でも shared/ のファイルを指す（階層が変わっても、すぐ気づける）', () => {
  let checked = 0;
  for (const f of clientFiles) {
    for (const m of read(f).matchAll(/^import\s*\{[^}]*\}\s*from\s*'([^']*shared\/[^']*)';$/gm)) {
      const spec = m[1];
      // ディスク：public/js/... の位置から、そのまま辿る
      const onDisk = path.resolve(path.dirname(f), spec);
      assert.ok(fs.existsSync(onDisk), `${rel(f)}: ディスクで ${spec} が見つかりません`);
      assert.equal(path.relative(ROOT, onDisk).split(path.sep)[0], 'shared', `${rel(f)}: ディスクで shared/ を指していません`);
      // ブラウザ：public/ が / に配信される。/js/... の URL から、同じ指定を辿ると /shared/... になること
      const url = new URL(spec, `http://localhost/${path.relative(path.join(ROOT, 'public'), f).split(path.sep).join('/')}`);
      assert.equal(url.pathname, `/shared/${path.basename(onDisk)}`, `${rel(f)}: URL で ${spec} が /shared/ を指していません（${url.pathname}）`);
      checked++;
    }
  }
  assert.ok(checked > 0, 'shared/ を読む import が、1つも見つかりません');
});

test('shared/ を読む import は、サーバーでも shared/ のファイルを指す', () => {
  for (const f of [...serverFiles, ...listJs(path.join(ROOT, 'server')).filter(isTest)]) {
    for (const m of read(f).matchAll(/^import\s*\{[^}]*\}\s*from\s*'([^']*shared\/[^']*)';$/gm)) {
      assert.ok(fs.existsSync(path.resolve(path.dirname(f), m[1])), `${rel(f)}: ${m[1]} が見つかりません`);
    }
  }
});

test('PHASE.X のような使い方は、shared/ に実在するキーを指している', () => {
  assert.ok(Object.keys(shared).length > 0);
  for (const f of [...clientFiles, ...serverFiles]) {
    const src = stripComments(read(f));
    for (const [name, obj] of Object.entries(shared)) {
      for (const m of src.matchAll(new RegExp(`\\b${name}\\.([A-Za-z_]+)`, 'g'))) {
        assert.ok(Object.hasOwn(obj, m[1]), `${rel(f)}: ${name}.${m[1]} は shared/ にありません`);
      }
    }
  }
});

test('フェーズ名の直書きは、shared/ の外に残っていない（定数 PHASE を使う）', () => {
  const PHASE_LITERAL = /'(lobby|topic|answer|reveal|vote|result)'|':(lobby|topic|answer|reveal|vote|result)'/;
  const allowed = new Set(["act(one ? 'choose' : 'vote'"]); // 「vote」は、フェーズではなく操作の名前
  for (const f of [...clientFiles, ...serverFiles]) {
    stripComments(read(f)).split('\n').forEach((line, i) => {
      if (!PHASE_LITERAL.test(line)) return;
      if ([...allowed].some((a) => line.includes(a))) return;
      assert.fail(`${rel(f)} の ${i + 1} 行付近に、フェーズ名の直書きが残っています: ${line.trim().slice(0, 100)}`);
    });
  }
});

// ---------- 通信メッセージ（shared/protocol.js） ----------

const CLIENT_TO_SERVER = ['CREATE', 'JOIN', 'ACT'];
const SERVER_TO_CLIENT = ['HELLO', 'JOINED', 'STATE', 'NOTICE', 'REACT', 'ERROR', 'NEED_CONFIRM', 'REMOVED', 'CLOSED', 'LEFT'];
const textOf = (files) => files.map((f) => stripComments(read(f))).join('\n');
const clientText = textOf(clientFiles);
const serverText = textOf(serverFiles);

test('通信の値は、これまでと同じ（直書きで固定。変えると、古い画面や古いサーバーとつながらなくなる）', () => {
  assert.deepEqual({ ...shared.MSG }, {
    CREATE: 'create', JOIN: 'join', ACT: 'act',
    HELLO: 'hello', JOINED: 'joined', STATE: 'state', NOTICE: 'notice', REACT: 'react', ERROR: 'error',
    NEED_CONFIRM: 'needConfirm', REMOVED: 'removed', CLOSED: 'closed', LEFT: 'left',
  });
  assert.deepEqual({ ...shared.ERR }, { NO_ROOM: 'no_room', BANNED: 'banned' });
  assert.deepEqual([...CLIENT_TO_SERVER, ...SERVER_TO_CLIENT].sort(), Object.keys(shared.MSG).sort()); // このテストの分類に、漏れがない
  assert.ok(Object.isFrozen(shared.MSG) && Object.isFrozen(shared.ERR));
});

test('メッセージ種別・エラーコードの直書きは、shared/ の外に残っていない', () => {
  const MSG_VALUES = 'hello|joined|state|notice|react|error|needConfirm|removed|closed|left|create|join|act';
  const patterns = [
    new RegExp(`\\bt: '(${MSG_VALUES})'`), // { t: 'state', … }
    new RegExp(`\\bmsg\\.t === '(${MSG_VALUES})'`),
    new RegExp(`\\bcase '(${MSG_VALUES})'`),
    /RoomError\('(no_room|banned)'/,
    /\bm\.code === '(no_room|banned)'/,
  ];
  for (const f of [...clientFiles, ...serverFiles]) {
    stripComments(read(f)).split('\n').forEach((line, i) => {
      for (const re of patterns) if (re.test(line)) assert.fail(`${rel(f)} の ${i + 1} 行付近に、直書きが残っています: ${line.trim().slice(0, 100)}`);
    });
  }
});

test('サーバーが送るメッセージは、すべて画面が受け取る。画面が送るメッセージは、すべてサーバーが受け取る', () => {
  const messages = read(path.join(ROOT, 'public/js/net/messages.js'));
  for (const k of SERVER_TO_CLIENT) {
    assert.ok(new RegExp(`\\bt: MSG\\.${k}\\b`).test(serverText), `サーバーが MSG.${k} を送っていません`);
    assert.ok(new RegExp(`case MSG\\.${k}\\b`).test(messages), `画面（net/messages.js）が MSG.${k} を受け取っていません`);
  }
  for (const k of CLIENT_TO_SERVER) {
    assert.ok(new RegExp(`\\bt: MSG\\.${k}\\b`).test(clientText), `画面が MSG.${k} を送っていません`);
    assert.ok(new RegExp(`msg\\.t === MSG\\.${k}\\b`).test(serverText), `サーバーが MSG.${k} を受け取っていません`);
  }
});

test('画面がエラーコードで動きを変えるもの（ERR）は、サーバーが実際に使っている', () => {
  for (const k of Object.keys(shared.ERR)) {
    assert.ok(new RegExp(`\\bERR\\.${k}\\b`).test(serverText), `サーバーが ERR.${k} を使っていません`);
    assert.ok(new RegExp(`\\bERR\\.${k}\\b`).test(clientText), `画面が ERR.${k} を見ていません`);
  }
});

test('画面が送る操作の名前（act）は、すべてサーバーの操作の表にある', () => {
  const server = read(path.join(ROOT, 'server/game/actions.js'));
  const table = new Set([...server.matchAll(/^ {2}([A-Za-z]+): /gm)].map((m) => m[1]));
  assert.ok(table.size > 20, '操作の表が読み取れていません');
  const sent = new Set();
  for (const m of clientText.matchAll(/\bact\(\s*'([A-Za-z]+)'/g)) sent.add(m[1]);
  for (const m of clientText.matchAll(/\bact\(\w+ \? '([A-Za-z]+)' : '([A-Za-z]+)'/g)) { sent.add(m[1]); sent.add(m[2]); } // 条件で切り替えるもの
  assert.ok(sent.size > 20, '画面が送る操作が読み取れていません');
  const missing = [...sent].filter((n) => !table.has(n));
  assert.deepEqual(missing, [], `サーバーにない操作を送っています: ${missing.join(', ')}`);
});

// ---------- 規則（shared/rules.js） ----------

const rules = await import(pathToFileURL(path.join(ROOT, 'shared/rules.js')).href);
const { Room } = await import(pathToFileURL(path.join(ROOT, 'server/game/room.js')).href);
const { newRoom, resetState } = await import(pathToFileURL(path.join(ROOT, 'public/js/core/state.js')).href);
const { MARKS } = await import(pathToFileURL(path.join(ROOT, 'public/js/lib/icons.js')).href);

test('規則の値は、これまでと同じ（直書きで固定。入力欄の上限や、遊べる人数が、知らないうちに変わらないように）', () => {
  assert.equal(rules.MIN_PLAYERS, 3);
  assert.equal(rules.ROOM_CODE_LENGTH, 4);
  assert.deepEqual([rules.MAX_NAME_LEN, rules.MAX_ANSWER_LEN, rules.MAX_THEME_LEN], [200, 100, 40]);
  assert.deepEqual([rules.TIME_LIMIT_MIN, rules.TIME_LIMIT_MAX], [5, 180]);
  assert.deepEqual([...rules.REACTIONS], ['like', 'bad', 'cheer', 'laugh']);
  assert.deepEqual({ ...rules.PRESENTER_MODE }, { HOST: 'host', ROTATION: 'rotation' });
  assert.deepEqual({ ...rules.IDENTITY_MODE }, { NAMED: 'named', ANONYMOUS: 'anonymous' });
  assert.deepEqual({ ...rules.CHOOSER_MODE }, { ALL: 'all', ONE: 'one' });
  assert.deepEqual({ ...rules.DEFAULT_SETTINGS }, { presenterMode: 'host', identityMode: 'named', chooserMode: 'all', timeLimit: 0 });
  for (const v of [rules.REACTIONS, rules.DEFAULT_SETTINGS, rules.PRESENTER_MODE, rules.IDENTITY_MODE, rules.CHOOSER_MODE]) assert.ok(Object.isFrozen(v));
});

test('部屋設定の既定値は、サーバーと画面（部屋をつくるときの選択）で、shared/ の DEFAULT_SETTINGS と同じ', () => {
  assert.deepEqual(new Room('T').settings, { ...rules.DEFAULT_SETTINGS, order: [] });
  resetState();
  assert.deepEqual({ ...newRoom }, { ...rules.DEFAULT_SETTINGS });
});

test('サーバーは、設定の選択肢と制限時間の範囲を、shared/ の規則どおりに受け付ける', () => {
  const room = new Room('T');
  const host = room.join(null, 'ホスト').id;
  const ok = (patch) => room.setSettings(host, patch);
  const bad = (patch) => assert.throws(() => room.setSettings(host, patch), (e) => e.code === 'bad_setting', JSON.stringify(patch));
  for (const [key, options] of [['presenterMode', rules.PRESENTER_MODE], ['identityMode', rules.IDENTITY_MODE], ['chooserMode', rules.CHOOSER_MODE]]) {
    for (const value of Object.values(options)) ok({ [key]: value });
    bad({ [key]: 'bogus' });
  }
  for (const n of [0, rules.TIME_LIMIT_MIN, rules.TIME_LIMIT_MAX, 30]) ok({ timeLimit: n });
  for (const n of [rules.TIME_LIMIT_MIN - 1, rules.TIME_LIMIT_MAX + 1, -1, 1.5]) bad({ timeLimit: n });
});

test('サーバーは、最低人数と入力の上限を、shared/ の規則どおりに適用する', () => {
  const room = new Room('T');
  const a = room.join(null, 'A').id;
  const b = room.join(null, 'B').id;
  assert.throws(() => room.startRound(a), (e) => e.code === 'min_players' && e.message.includes(`${rules.MIN_PLAYERS}人以上`));
  assert.equal(room.viewFor(a).me.name.length <= rules.MAX_NAME_LEN, true);
  const long = room.join(null, 'あ'.repeat(rules.MAX_NAME_LEN + 50)).id;
  assert.equal(room.viewFor(long).me.name.length, rules.MAX_NAME_LEN); // 入室のときに、上限で切られる
  assert.throws(() => room.rename(long, 'い'.repeat(rules.MAX_NAME_LEN + 1)), (e) => e.code === 'bad_name');
  room.startRound(a);
  assert.throws(() => room.setTopic(a, { hiragana: 'あ', theme: 'x'.repeat(rules.MAX_THEME_LEN + 1) }), (e) => e.code === 'bad_topic');
  room.setTopic(a, { hiragana: 'あ', theme: 'x'.repeat(rules.MAX_THEME_LEN) });
  room.confirmTopic(a);
  assert.throws(() => room.submitAnswer(a, 'y'.repeat(rules.MAX_ANSWER_LEN + 1)), (e) => e.code === 'bad_answer');
  room.submitAnswer(a, 'y'.repeat(rules.MAX_ANSWER_LEN));
  room.submitAnswer(b, 'z');
  room.submitAnswer(long, 'z');
  room.advance(a, { force: true }); // 開示へ（反応マークは、開示のあいだだけ使える）
  for (const kind of rules.REACTIONS) room.react(a, kind); // 連打の制限で null が返ることはあるが、エラーにはならない
  assert.throws(() => room.react(a, 'unknown'), (e) => e.code === 'bad_reaction');
});

test('反応マークの絵文字（画面の MARKS）は、shared/ の REACTIONS と同じ種類', () => {
  assert.deepEqual(Object.keys(MARKS).sort(), [...rules.REACTIONS].sort());
});

test('設定の値や、人数・文字数の直書きは、shared/ の外に残っていない', () => {
  const SETTING_LITERAL = /'(host|rotation|named|anonymous|all|one)'/;
  const NUMBER_LITERALS = [/\bn < 3\b/, /\{4\}\$/, /maxlength="(4|40|100|200)"/, /\bcode\.length < 4\b/]; // {4}$ は、部屋コードの正規表現（どの書き方でも）
  const code = (line) => line.replace(/\s\/\/\s.*$/, ''); // 行末のコメントは、見ない
  for (const f of [...clientFiles, ...serverFiles]) {
    stripComments(read(f)).split('\n').forEach((raw, i) => {
      const line = code(raw);
      if (SETTING_LITERAL.test(line)) assert.fail(`${rel(f)} の ${i + 1} 行付近に、設定の値の直書きが残っています: ${line.trim().slice(0, 100)}`);
      for (const re of NUMBER_LITERALS) if (re.test(line)) assert.fail(`${rel(f)} の ${i + 1} 行付近に、数字の直書きが残っています: ${line.trim().slice(0, 100)}`);
    });
  }
});
