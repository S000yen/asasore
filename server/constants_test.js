import test from 'node:test';
import assert from 'node:assert/strict';
import { EVENT } from './events.js';
import { PHASE, BETWEEN_ROUNDS, SPECTATE_NOW_PHASES, ANSWERS_SHOWN_PHASES, GROUPING_PHASES } from '../shared/phases.js';
import { NOTICES } from './messages.js';

// フェーズ名は通信（view.phase）に載り、画面側も同じ文字列で見ている。この値が変わったら、気づけるようにしておく。
test('PHASE：通信に載る値は、これまでと同じ', () => {
  assert.deepEqual({ ...PHASE }, { LOBBY: 'lobby', TOPIC: 'topic', ANSWER: 'answer', REVEAL: 'reveal', VOTE: 'vote', RESULT: 'result' });
  assert.ok(Object.isFrozen(PHASE));
});

test('フェーズのまとまり：中身と、凍結', () => {
  assert.deepEqual([...BETWEEN_ROUNDS], ['lobby', 'result']);
  assert.deepEqual([...SPECTATE_NOW_PHASES], ['lobby', 'topic', 'answer', 'result']);
  assert.deepEqual([...ANSWERS_SHOWN_PHASES], ['reveal', 'vote', 'result']);
  assert.deepEqual([...GROUPING_PHASES], ['reveal', 'vote']);
  for (const list of [BETWEEN_ROUNDS, SPECTATE_NOW_PHASES, ANSWERS_SHOWN_PHASES, GROUPING_PHASES]) {
    assert.ok(Object.isFrozen(list));
    assert.ok(list.every((p) => Object.values(PHASE).includes(p))); // 知らないフェーズが混ざっていない
  }
});

test('EVENT：値はキーの小文字で、重ならず、凍結されている', () => {
  assert.ok(Object.isFrozen(EVENT));
  for (const [key, value] of Object.entries(EVENT)) assert.equal(value, key.toLowerCase(), key);
  const values = Object.values(EVENT);
  assert.equal(new Set(values).size, values.length);
  assert.equal(values.length, 20);
});

test('通知文の表：全てのイベント種別について、通知を出すか出さないかが決めてあり、余計なものもない', () => {
  const types = Object.values(EVENT);
  for (const type of types) assert.ok(Object.hasOwn(NOTICES, type), `${type} の通知の有無が、messages.js に書かれていません`);
  for (const key of Object.keys(NOTICES)) assert.ok(types.includes(key), `${key} は EVENT にありません`);
});
