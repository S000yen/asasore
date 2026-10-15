// 画面の HTML が、記録しておいた正解（golden.json）と同じであることを確かめる。
// 画面を分割・整理しても、見た目（HTML）が変わっていないことを守るためのテスト。
// 画面を意図して変えたときは、node client_test/update_golden.js で作り直す。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderScenario } from './runner.js';

const dir = fileURLToPath(new URL('.', import.meta.url));
const { views, scenarios } = JSON.parse(fs.readFileSync(`${dir}fixtures.json`, 'utf8'));
const golden = JSON.parse(fs.readFileSync(`${dir}golden.json`, 'utf8'));

function firstDiff(a, b) {
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  return i;
}

test('シナリオと正解データの名前が、過不足なく対応している', () => {
  assert.deepEqual(scenarios.map((s) => s.name).sort(), Object.keys(golden).sort());
});

test('正解データが空だったり、壊れていたりしない（実装が動いていないのに通ってしまうのを防ぐ）', () => {
  for (const [name, html] of Object.entries(golden)) {
    assert.ok(html.length > 100, `${name}: HTML が短すぎます`);
    assert.ok(!/undefined|NaN|\[object /.test(html), `${name}: undefined / NaN / [object が混ざっています`);
  }
  // 場面ごとに、ちゃんと違う HTML が出ている（一般と観戦のように、同じ画面になる組み合わせはあるので、全部が違うわけではない）
  assert.ok(new Set(Object.values(golden)).size > scenarios.length * 0.6);
});

test('各フェーズ・各シートの画面に、その画面らしい内容が入っている', () => {
  const has = (name, ...texts) => { for (const t of texts) assert.ok(golden[name].includes(t), `${name} に「${t}」がありません`); };
  has('named-all/r0-lobby/host', '参加者 5人', 'はじめる');
  has('named-all/r1-topic-draft/host', 'tile-input', 'この題で決定');
  has('named-all/r1-answer-partial/host', '答えを入力', '回答状況 1/4', '1:05');
  has('named-all/r1-reveal-grouped/host', '開示済み 4/4', 'まとめを編集', 'gtag');
  has('named-all/r1-vote-partial/host', '正解だと思う回答に投票', '投票状況');
  has('named-all/r1-result/host', '正解', '次のラウンドへ', 'vcount');
  has('named-one/r1-vote-chooser-a/a', '正解を選んでください');
  has('extra/tie-result/host', '同票：どれも正解');
  has('extra/noanswer-result/host', '全員不正解！', '回答がありませんでした');
  has('variant/menu-host-lobby', 'メニュー', '招待リンクを共有', '主催者を譲る', '部屋を閉じる');
  has('variant/sheet-history', 'これまでの記録', '得票率');
  has('variant/sheet-howto', '遊び方', 'ルールの種類');
  has('variant/modal-confirm', '進める');
  has('variant/editing-reveal', 'まとめる', 'ばらす', 'checkbox');
  has('entry/create-dialog', '部屋をつくる', '回答の制限時間');
  has('entry/end-banned', 'この部屋には入れません', 'もう一度入る');
  // 記号や長い名前は、そのまま出ず、画面の文字として扱われる
  assert.ok(!golden['named-all/r0-lobby/host'].includes('<ボブ>'));
  assert.ok(golden['named-all/r0-lobby/host'].includes('&lt;ボブ&gt;'));
  assert.ok(!golden['named-all/r1-reveal-grouped/host'].includes('<script>'));
});

test('全てのシナリオで、画面の HTML が正解データと一致する', () => {
  const bad = [];
  for (const sc of scenarios) {
    const html = renderScenario(sc, views);
    if (html !== golden[sc.name]) {
      const i = firstDiff(html, golden[sc.name]);
      bad.push(`${sc.name}: ${i}文字目から違います\n    期待: …${golden[sc.name].slice(Math.max(0, i - 40), i + 80)}…\n    実際: …${html.slice(Math.max(0, i - 40), i + 80)}…`);
    }
  }
  assert.equal(bad.length, 0, `${bad.length} 件が違います（最初の5件）:\n${bad.slice(0, 5).join('\n')}`);
});

test('同じシナリオを何度描いても、同じ HTML になる（乱数や時刻に左右されない）', () => {
  for (const sc of scenarios.filter((_, i) => i % 7 === 0)) {
    assert.equal(renderScenario(sc, views), renderScenario(sc, views), sc.name);
  }
});
