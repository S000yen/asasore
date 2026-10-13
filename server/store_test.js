import test from 'node:test';
import assert from 'node:assert/strict';
import { newDb } from 'pg-mem';
import { PgStore } from './store.js';

// pg-mem は、Postgres の動きを真似るメモリ上のもの。SQL の文法と、重複時の動きを確かめる。
function freshStore() {
  // 「表がすでにある場合の IF NOT EXISTS」を、pg-mem が厳しく見すぎるため、その検査だけ切る（本物のPostgresでは問題ない文）
  const { Pool } = newDb({ noAstCoverageCheck: true }).adapters.createPg();
  return new PgStore(new Pool());
}

test('初回の読み込みで、表ができて、シードの題材が入る', async () => {
  const store = freshStore();
  const seed = Array.from({ length: 250 }, (_, i) => `題材${i}`); // 100件ずつのまとめ入れをまたぐ
  const { themes, flags } = await store.load(seed);
  assert.equal(themes.length, 250);
  assert.equal(flags.length, 0);
  assert.ok(themes.every((t) => t.source === 'seed'));
});

test('2回目の起動でも、重複せず、報告は消えない', async () => {
  const store = freshStore();
  await store.load(['A', 'B']);
  await store.addFlag('A', 'c1');
  await store.addTheme('手入力', 'user');
  const second = await store.load(['A', 'B', 'C']); // シードが増えた起動
  assert.deepEqual(second.themes.map((t) => t.theme).sort(), ['A', 'B', 'C', '手入力']);
  assert.deepEqual(second.flags, [{ theme: 'A', client_id: 'c1' }]);
});

test('同じ題材・同じ端末の保存を繰り返しても、エラーにならず、1件のまま', async () => {
  const store = freshStore();
  await store.load([]);
  await store.addTheme('X', 'user');
  await store.addTheme('X', 'user');
  await store.addFlag('X', 'c1');
  await store.addFlag('X', 'c1');
  await store.addFlag('X', 'c2');
  const { themes, flags } = await store.load([]);
  assert.equal(themes.length, 1);
  assert.equal(flags.length, 2);
});

test('記号を含む題材も、そのまま保存される（SQLに直接組み込んでいない）', async () => {
  const store = freshStore();
  await store.load([]);
  const weird = "'; DROP TABLE themes; --";
  await store.addTheme(weird, 'user');
  await store.addFlag(weird, 'c1');
  const { themes, flags } = await store.load([]);
  assert.equal(themes[0].theme, weird);
  assert.equal(flags[0].theme, weird);
});
