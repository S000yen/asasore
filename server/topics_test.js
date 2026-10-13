import test from 'node:test';
import assert from 'node:assert/strict';
import { TopicPool } from './topics.js';

const quiet = { log() {}, error() {} };

test('報告した端末が増えるほど出にくくなり、上限で出なくなる', () => {
  const pool = new TopicPool(['A', 'B'], { hideAt: 3 });
  assert.equal(pool.weightOf('A'), 1);
  pool.flag('A', 'c1');
  assert.equal(pool.weightOf('A'), 0.5);
  pool.flag('A', 'c2');
  assert.equal(pool.weightOf('A'), 0.25);
  const r = pool.flag('A', 'c3');
  assert.equal(r.hidden, true);
  assert.equal(pool.weightOf('A'), 0);
  for (let i = 0; i < 200; i++) assert.equal(pool.randomTheme(), 'B'); // もう A は出ない
});

test('同じ端末の報告は、何度押しても1回と数える', () => {
  const pool = new TopicPool(['A'], { hideAt: 5 });
  assert.equal(pool.flag('A', 'c1').counted, true);
  assert.equal(pool.flag('A', 'c1').counted, false);
  assert.equal(pool.flag('A', 'c1').counted, false);
  assert.equal(pool.weightOf('A'), 0.5);
});

test('登録されていない題材・端末IDなしの報告は数えない', () => {
  const pool = new TopicPool(['A']);
  assert.equal(pool.flag('なぞの題材', 'c1').counted, false);
  assert.equal(pool.flag('A', null).counted, false);
  assert.equal(pool.weightOf('A'), 1);
});

test('出現率：報告の多い題材ほど、出る回数が減る', () => {
  const pool = new TopicPool(['A', 'B'], { hideAt: 5 });
  pool.flag('A', 'c1'); pool.flag('A', 'c2'); // A は 0.25、B は 1
  const count = { A: 0, B: 0 };
  for (let i = 0; i < 5000; i++) count[pool.randomTheme()]++;
  const ratio = count.A / count.B; // 期待値 0.25
  assert.ok(ratio > 0.18 && ratio < 0.33, `ratio=${ratio}`);
});

test('その部屋で使った題材・報告された題材は出さない', () => {
  const pool = new TopicPool(['A', 'B', 'C']);
  const filter = { used: new Set(['A']), blocked: new Set(['B']) };
  for (let i = 0; i < 100; i++) assert.equal(pool.randomTheme(undefined, filter), 'C');
});

test('候補が尽きたら、使った題材だけを戻して引き直す（報告された題材は戻さない）', () => {
  const pool = new TopicPool(['A', 'B', 'C']);
  const filter = { used: new Set(['A', 'C']), blocked: new Set(['B']) };
  const t = pool.randomTheme(undefined, filter);
  assert.ok(['A', 'C'].includes(t)); // B は出ない
  assert.equal(filter.used.size, 0); // 使った記録は、リセットされた
  for (let i = 0; i < 100; i++) assert.notEqual(pool.randomTheme(undefined, filter), 'B');
});

test('引ける題材が1つもなければ、いまの題材のまま（止まらない）', () => {
  const pool = new TopicPool(['A']);
  assert.equal(pool.randomTheme('A', { used: new Set(), blocked: new Set(['A']) }), 'A');
});

test('draw: 題材だけ引き直すと、ひらがなは残り、いまの題材は出ない', () => {
  const pool = new TopicPool(['A', 'B']);
  for (let i = 0; i < 50; i++) {
    const r = pool.draw({ hiragana: 'あ', theme: 'A' }, 'theme', { used: new Set(), blocked: new Set() });
    assert.deepEqual(r, { hiragana: 'あ', theme: 'B' });
  }
});

test('ひらがなの抽選に、濁音・半濁音・小書き・ん・を は出ない', () => {
  const pool = new TopicPool(['A']);
  const seen = new Set();
  for (let i = 0; i < 3000; i++) seen.add(pool.randomHiragana());
  assert.equal(seen.size, 44);
  for (const ch of 'がぱんをっゃぁ') assert.equal(seen.has(ch), false);
});

test('ひらがなは、どの文字も同じ確率で出る（答えにくい文字も減らさない）', () => {
  const pool = new TopicPool(['A']);
  const n = 44000, count = {};
  for (let i = 0; i < n; i++) { const c = pool.randomHiragana(); count[c] = (count[c] ?? 0) + 1; }
  for (const ch of 'ぬねむめゆへえろれわ') {
    assert.ok(count[ch] > 800 && count[ch] < 1200, `${ch}: ${count[ch]}`); // 期待値は1000
  }
});

test('手入力で確定した新しい題材は、一覧に加わり、保存される', async () => {
  const saved = { themes: [], flags: [] };
  const store = {
    load: async (seed) => ({ themes: seed.map((theme) => ({ theme })), flags: [] }), // 本物のストアは、シードを入れてから返す
    addTheme: async (t, s) => { saved.themes.push([t, s]); },
    addFlag: async (t, c) => { saved.flags.push([t, c]); },
  };
  const pool = new TopicPool(['A']);
  await pool.attach(store, { retryMs: 0, log: quiet });
  assert.deepEqual(pool.register({ hiragana: 'あ', theme: '新しい題材' }), { newTheme: true, newPair: true });
  assert.deepEqual(pool.register({ hiragana: 'い', theme: '新しい題材' }), { newTheme: false, newPair: true });
  pool.flag('A', 'c1');
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(saved.themes, [['新しい題材', 'user']]); // 2回目は、保存し直さない
  assert.deepEqual(saved.flags, [['A', 'c1']]);
  assert.equal(pool.has('新しい題材'), true);
});

test('起動時に、保存済みの題材と報告を読み込む', async () => {
  const store = {
    load: async () => ({ themes: [{ theme: 'A' }, { theme: '前に増えた題材' }], flags: [{ theme: 'A', client_id: 'c1' }, { theme: 'A', client_id: 'c2' }] }),
    addTheme: async () => {}, addFlag: async () => {},
  };
  const pool = new TopicPool(['A', 'B'], { hideAt: 2 });
  assert.equal(await pool.attach(store, { retryMs: 0, log: quiet }), true);
  assert.equal(pool.has('前に増えた題材'), true);
  assert.equal(pool.weightOf('A'), 0); // 読み込んだ報告で、すでに出ない
});

test('保存先がつながらなくても動き、つながったら、その間の分を保存する', async () => {
  let fail = true;
  const saved = { themes: [], flags: [] };
  const store = {
    load: async (seed) => { if (fail) throw new Error('つながらない'); return { themes: seed.map((theme) => ({ theme })), flags: [] }; },
    addTheme: async (t) => { saved.themes.push(t); },
    addFlag: async (t, c) => { saved.flags.push([t, c]); },
  };
  const pool = new TopicPool(['A']);
  assert.equal(await pool.attach(store, { retryMs: 20, log: quiet }), false);
  assert.ok(pool.randomTheme()); // ゲームは続く
  pool.register({ hiragana: 'あ', theme: '停止中に増えた題材' });
  pool.flag('A', 'c9');
  fail = false;
  await new Promise((r) => setTimeout(r, 150)); // 再試行を待つ
  assert.equal(pool.ready, true);
  assert.deepEqual(saved.themes, ['停止中に増えた題材']);
  assert.deepEqual(saved.flags, [['A', 'c9']]);
  clearTimeout(pool.retryTimer);
});
