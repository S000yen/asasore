// 制限時間のバーで、180秒と「なし」の間に、つまみが止まらないことを確かめる。

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { TIME_LIMIT_MIN, TIME_LIMIT_MAX } from '../shared/rules.js';

const ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const { keyJump, sliderVal, snapPos, timeSliderHtml } = await import(pathToFileURL(path.join(ROOT, 'public', 'js', 'ui', 'components', 'parts.js')).href);

// バーの HTML から、いちばん右（「なし」）の位置と、刻みを読む
const html = timeSliderHtml(0, 'create');
const NONE = Number(html.match(/max="(\d+)"/)[1]);
const STEP = Number(html.match(/step="(\d+)"/)[1]);

test('「なし」は、180秒の目盛りから離れた所にある（間の位置ができる前提）', () => {
  assert.ok(NONE - TIME_LIMIT_MAX > STEP);
});

test('180秒までは、その位置のまま', () => {
  for (let p = TIME_LIMIT_MIN; p <= TIME_LIMIT_MAX; p += STEP) assert.equal(snapPos(p), p);
});

test('180秒と「なし」の間は、近いほうへ吸い付く', () => {
  for (let p = TIME_LIMIT_MAX + STEP; p < NONE; p += STEP) {
    const want = p - TIME_LIMIT_MAX < NONE - p ? TIME_LIMIT_MAX : NONE;
    assert.equal(snapPos(p), want, `${p} の位置`);
  }
  assert.equal(snapPos(NONE), NONE);
  assert.equal(snapPos(String(TIME_LIMIT_MAX + STEP)), TIME_LIMIT_MAX); // つまみの値は文字列で届く
});

test('寄せたあとの位置は、180秒か「なし」（制限時間 0）になる', () => {
  for (let p = TIME_LIMIT_MAX; p <= NONE; p += STEP) {
    const v = sliderVal({ value: String(snapPos(p)) });
    assert.ok(v === TIME_LIMIT_MAX || v === 0, `${p} の位置が ${v} になった`);
  }
});

test('矢印キーで、180秒と「なし」の間を1回で跳ぶ', () => {
  assert.equal(keyJump(TIME_LIMIT_MAX, 'ArrowRight'), NONE);
  assert.equal(keyJump(TIME_LIMIT_MAX, 'ArrowUp'), NONE);
  assert.equal(keyJump(NONE, 'ArrowLeft'), TIME_LIMIT_MAX);
  assert.equal(keyJump(String(NONE), 'ArrowDown'), TIME_LIMIT_MAX);
});

test('ほかの位置やキーでは跳ばない（ふつうに動かす）', () => {
  assert.equal(keyJump(TIME_LIMIT_MAX, 'ArrowLeft'), null);
  assert.equal(keyJump(NONE, 'ArrowRight'), null);
  assert.equal(keyJump(60, 'ArrowRight'), null);
  assert.equal(keyJump(TIME_LIMIT_MAX, 'Home'), null);
});
