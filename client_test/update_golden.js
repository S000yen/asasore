// 画面の HTML の正解データ（golden.json）を、いまの実装から作り直す。
//   使い方: node client_test/update_golden.js
//
// 画面を意図して変えたときだけ実行する。実行したら、git の差分で、変わった場面が意図どおりかを確かめること。

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderScenario } from './runner.js';

const dir = fileURLToPath(new URL('.', import.meta.url));
const { views, scenarios } = JSON.parse(fs.readFileSync(`${dir}fixtures.json`, 'utf8'));

// 1シナリオにつき1行で書く（差分が読めるように）
const body = scenarios.map((sc) => `${JSON.stringify(sc.name)}: ${JSON.stringify(renderScenario(sc, views))}`).join(',\n');
fs.writeFileSync(`${dir}golden.json`, `{\n${body}\n}\n`);
console.log(`${scenarios.length} 件の HTML を書き出しました`);
