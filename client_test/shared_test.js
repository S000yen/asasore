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
