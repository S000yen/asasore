import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { computeBuild, createRequestHandler, PUBLIC_DIR } from './http.js';
import { TopicPool } from './topics.js';

// 一時フォルダに、小さな public/ と shared/ を作る。root/public・root/shared と、名前が前方一致する root/public2・root/shared2 と、外の root/secret.txt も置く。
function makePublic(files = {}, sharedFiles = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asaso-http-'));
  const publicDir = path.join(root, 'public');
  const sharedDir = path.join(root, 'shared');
  const all = {
    'index.html': '<html><head><title>t</title></head><body>top</body></html>',
    'app.js': 'console.log(1)',
    'style.css': 'body{}',
    'howto.md': '# how',
    'icons/a.png': 'PNG',
    'data.bin': 'BIN',
    'sub/index.html': '<head></head>sub',
    ...files,
  };
  for (const [rel, body] of Object.entries(all)) {
    fs.mkdirSync(path.dirname(path.join(publicDir, rel)), { recursive: true });
    fs.writeFileSync(path.join(publicDir, rel), body);
  }
  const shared = { 'rules.js': 'export const X = 1;', 'sub/deep.js': 'export const DEEP = 2;', 'page.html': '<head></head>shared', ...sharedFiles };
  for (const [rel, body] of Object.entries(shared)) {
    fs.mkdirSync(path.dirname(path.join(sharedDir, rel)), { recursive: true });
    fs.writeFileSync(path.join(sharedDir, rel), body);
  }
  for (const sibling of ['public2', 'shared2']) {
    fs.mkdirSync(path.join(root, sibling));
    fs.writeFileSync(path.join(root, sibling, 'x.txt'), 'sibling');
  }
  fs.writeFileSync(path.join(root, 'secret.txt'), 'secret');
  return { root, publicDir, sharedDir };
}

async function serve(t, { files, sharedFiles, adminToken = '' } = {}) {
  const { root, publicDir, sharedDir } = makePublic(files, sharedFiles);
  const build = computeBuild(publicDir, sharedDir);
  const handler = createRequestHandler({ topics: new TopicPool(['A']), rooms: new Map(), build, startedAt: Date.now(), publicDir, sharedDir, adminToken });
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => { server.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { base, port: server.address().port, build };
}

// fetch はパスを整えてしまうので、生のパスをそのまま送りたいときに使う
const raw = (port, rawPath) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path: rawPath }, (res) => {
    let body = '';
    res.on('data', (c) => { body += c; });
    res.on('end', () => resolve({ status: res.statusCode, body }));
  }).on('error', reject);
});

test('/health は ok を返し、キャッシュさせない', async (t) => {
  const s = await serve(t);
  const res = await fetch(`${s.base}/health`);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'ok');
  assert.equal(res.headers.get('cache-control'), 'no-store');
});

test('/ は index.html で、</head> の前に配信中の版が入る', async (t) => {
  const s = await serve(t);
  const res = await fetch(`${s.base}/`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.equal(res.headers.get('cache-control'), 'no-cache');
  const html = await res.text();
  assert.ok(html.includes(`<meta name="build" content="${s.build}">\n</head>`));
  assert.ok(html.includes('<title>t</title>')); // 元の内容は、そのまま
});

test('フォルダの末尾が / なら、その中の index.html。そこにも版が入る', async (t) => {
  const s = await serve(t);
  const html = await (await fetch(`${s.base}/sub/`)).text();
  assert.ok(html.endsWith('sub'));
  assert.ok(html.includes(`content="${s.build}"`));
});

test('拡張子に合わせた Content-Type（知らない拡張子は octet-stream）', async (t) => {
  const s = await serve(t);
  const type = async (p) => (await fetch(`${s.base}${p}`)).headers.get('content-type');
  assert.equal(await type('/app.js'), 'text/javascript; charset=utf-8');
  assert.equal(await type('/style.css'), 'text/css; charset=utf-8');
  assert.equal(await type('/howto.md'), 'text/markdown; charset=utf-8');
  assert.equal(await type('/icons/a.png'), 'image/png');
  assert.equal(await type('/data.bin'), 'application/octet-stream');
});

test('index.html 以外には、版を差し込まない', async (t) => {
  const s = await serve(t);
  assert.equal(await (await fetch(`${s.base}/app.js`)).text(), 'console.log(1)');
});

test('public の外は 403（..、エンコードした ..、名前が前方一致する兄弟フォルダ）', async (t) => {
  const s = await serve(t);
  for (const p of ['/..%2fsecret.txt', '/..%2f..%2fsecret.txt', '/..%2fpublic2%2fx.txt', '/%2e%2e%2fsecret.txt']) {
    const r = await raw(s.port, p);
    assert.equal(r.status, 403, p);
    assert.equal(r.body, 'forbidden', p);
  }
});

test('見つからない・フォルダ・壊れたパスは 404', async (t) => {
  const s = await serve(t);
  for (const p of ['/nothing.js', '/icons', '/%E0%A4%A']) {
    const r = await raw(s.port, p);
    assert.equal(r.status, 404, p);
    assert.equal(r.body, 'not found', p);
  }
});

test('合言葉の設定がなければ、/admin は存在しないことにする', async (t) => {
  const s = await serve(t, { adminToken: '' });
  assert.equal((await fetch(`${s.base}/admin`)).status, 404);
  assert.equal((await fetch(`${s.base}/admin/api/status`, { method: 'POST' })).status, 404);
});

test('/admin：ページを返し、合言葉が合えば状態（配信中の版を含む）を返す', async (t) => {
  const s = await serve(t, { adminToken: 'tok' });
  const page = await fetch(`${s.base}/admin`);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('content-type'), 'text/html; charset=utf-8');
  const bad = await fetch(`${s.base}/admin/api/status`, { method: 'POST', headers: { 'x-admin-token': 'wrong' } });
  assert.equal(bad.status, 401);
  const ok = await fetch(`${s.base}/admin/api/status`, { method: 'POST', headers: { 'x-admin-token': 'tok' } });
  assert.equal(ok.status, 200);
  const j = await ok.json();
  assert.equal(j.build, s.build);
  assert.deepEqual(j.rooms, { count: 0, connectedPlayers: 0 });
});

test('computeBuild：中身が同じなら同じ版、変われば別の版（10文字）', () => {
  const a = makePublic();
  const b = makePublic();
  const v1 = computeBuild(a.publicDir, a.sharedDir);
  assert.match(v1, /^[0-9a-f]{10}$/);
  assert.equal(computeBuild(b.publicDir, b.sharedDir), v1);
  for (const f of ['index.html', 'app.js', 'style.css', 'howto.md']) {
    const before = computeBuild(a.publicDir, a.sharedDir);
    fs.appendFileSync(path.join(a.publicDir, f), ' ');
    assert.notEqual(computeBuild(a.publicDir, a.sharedDir), before, f);
  }
  const unrelated = computeBuild(b.publicDir, b.sharedDir);
  fs.appendFileSync(path.join(b.publicDir, 'data.bin'), ' '); // 版に含めないファイル
  assert.equal(computeBuild(b.publicDir, b.sharedDir), unrelated);
  fs.rmSync(a.root, { recursive: true, force: true });
  fs.rmSync(b.root, { recursive: true, force: true });
});

test('computeBuild：本物の public/ からは版が出る（shared/ が無くてもよい）', () => {
  assert.match(computeBuild(PUBLIC_DIR), /^[0-9a-f]{10}$/);
});

// ---------- shared/ の配信 ----------

test('/shared/ の下は、shared/ のファイルを配信する（版は差し込まない）', async (t) => {
  const s = await serve(t);
  const res = await fetch(`${s.base}/shared/rules.js`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/javascript; charset=utf-8');
  assert.equal(res.headers.get('cache-control'), 'no-cache');
  assert.equal(await res.text(), 'export const X = 1;');
  assert.equal(await (await fetch(`${s.base}/shared/sub/deep.js`)).text(), 'export const DEEP = 2;'); // 入れ子のフォルダも配信される
  assert.equal(await (await fetch(`${s.base}/shared/page.html`)).text(), '<head></head>shared'); // html でも、版を差し込まない
});

test('shared/ の index.html にも、版は差し込まない（public/ の index.html だけに差し込む）', async (t) => {
  const s = await serve(t, { sharedFiles: { 'index.html': '<head></head>shared-index' } });
  assert.equal(await (await fetch(`${s.base}/shared/index.html`)).text(), '<head></head>shared-index');
  assert.equal(await (await fetch(`${s.base}/shared/`)).text(), '<head></head>shared-index'); // 末尾が / なら index.html
  assert.ok((await (await fetch(`${s.base}/`)).text()).includes(`content="${s.build}"`)); // public/ のほうには入る
});

test('shared/ と public/ は、混ざらない', async (t) => {
  const s = await serve(t);
  assert.equal((await fetch(`${s.base}/rules.js`)).status, 404); // shared のファイルは、/ 直下には出ない
  assert.equal((await fetch(`${s.base}/shared/app.js`)).status, 404); // public のファイルは、/shared/ には出ない
  assert.equal(await (await fetch(`${s.base}/app.js`)).text(), 'console.log(1)');
});

test('/shared/ の外へは出られない（403）。shared の兄弟フォルダや public へも', async (t) => {
  const s = await serve(t);
  for (const p of ['/shared/..%2fsecret.txt', '/shared/..%2fshared2%2fx.txt', '/shared/..%2fpublic%2fapp.js', '/shared/..%2f..%2fsecret.txt']) {
    const r = await raw(s.port, p);
    assert.equal(r.status, 403, p);
    assert.equal(r.body, 'forbidden', p);
  }
});

test('/shared/ の404：無いファイル、フォルダ、index.html の無い /shared/、/shared（末尾の / なし）、壊れたパス', async (t) => {
  const s = await serve(t);
  for (const p of ['/shared/nothing.js', '/shared/sub', '/shared/', '/shared', '/shared/%E0%A4%A']) {
    const r = await raw(s.port, p);
    assert.equal(r.status, 404, p);
  }
});

// ---------- 版が、複数のフォルダ・ファイルにまたがること ----------

test('computeBuild：入れ子のフォルダの JS も、shared/ のファイルも、版に含まれる', () => {
  const a = makePublic({ 'js/views/room.js': 'v1' });
  const base = computeBuild(a.publicDir, a.sharedDir);
  const changes = (label, edit) => {
    const before = computeBuild(a.publicDir, a.sharedDir);
    edit();
    assert.notEqual(computeBuild(a.publicDir, a.sharedDir), before, label);
  };
  changes('入れ子の JS が変わった', () => fs.writeFileSync(path.join(a.publicDir, 'js/views/room.js'), 'v2'));
  changes('JS が増えた', () => fs.writeFileSync(path.join(a.publicDir, 'js/new.js'), 'x'));
  changes('shared の JS が変わった', () => fs.appendFileSync(path.join(a.sharedDir, 'rules.js'), ' '));
  changes('shared の入れ子の JS が変わった', () => fs.appendFileSync(path.join(a.sharedDir, 'sub/deep.js'), ' '));
  changes('shared に JS が増えた', () => fs.writeFileSync(path.join(a.sharedDir, 'more.js'), 'x'));
  changes('ファイルが消えた', () => fs.rmSync(path.join(a.publicDir, 'js/new.js')));
  assert.notEqual(computeBuild(a.publicDir, a.sharedDir), base);
  fs.rmSync(a.root, { recursive: true, force: true });
});

// 中身も、ファイルの並び順も同じで、パスだけが違う2つの組を比べる（パス自体が版に効いていることを確かめるため）
function tinyDirs(publicFiles, sharedFiles) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asaso-tiny-'));
  const dirs = { root, publicDir: path.join(root, 'public'), sharedDir: path.join(root, 'shared') };
  for (const [dir, files] of [[dirs.publicDir, publicFiles], [dirs.sharedDir, sharedFiles]]) {
    fs.mkdirSync(dir);
    for (const [rel, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, rel), body);
  }
  return dirs;
}

test('computeBuild：パスも版に含む（同じ中身で並びも同じでも、名前が違えば別の版）', () => {
  const a = tinyDirs({ 'one.js': 'same', 'zzz.js': 'other' }, {});
  const b = tinyDirs({ 'onb.js': 'same', 'zzz.js': 'other' }, {}); // 名前だけ違う（並びは同じ）
  assert.notEqual(computeBuild(a.publicDir, a.sharedDir), computeBuild(b.publicDir, b.sharedDir));
  fs.rmSync(a.root, { recursive: true, force: true });
  fs.rmSync(b.root, { recursive: true, force: true });
});

test('computeBuild：public と shared の取り違えも区別する（同じ名前・同じ中身でも、置き場所が違えば別の版）', () => {
  const inPublic = tinyDirs({ 'x.js': 'same' }, {});
  const inShared = tinyDirs({}, { 'x.js': 'same' });
  assert.notEqual(computeBuild(inPublic.publicDir, inPublic.sharedDir), computeBuild(inShared.publicDir, inShared.sharedDir));
  fs.rmSync(inPublic.root, { recursive: true, force: true });
  fs.rmSync(inShared.root, { recursive: true, force: true });
});

test('computeBuild：ファイルを作った順や、フォルダの中の並びに左右されない', () => {
  const a = makePublic({ 'js/a.js': '1', 'js/b.js': '2', 'z.js': '3' });
  const b = makePublic({ 'z.js': '3', 'js/b.js': '2', 'js/a.js': '1' });
  assert.equal(computeBuild(a.publicDir, a.sharedDir), computeBuild(b.publicDir, b.sharedDir));
  fs.rmSync(a.root, { recursive: true, force: true });
  fs.rmSync(b.root, { recursive: true, force: true });
});

test('computeBuild：版の対象でない種類のファイル（画像・json・manifest など）は、版に影響しない', () => {
  const a = makePublic({ 'manifest.webmanifest': '{}', 'data.json': '{}' });
  const before = computeBuild(a.publicDir, a.sharedDir);
  for (const rel of ['icons/a.png', 'data.bin', 'manifest.webmanifest', 'data.json']) fs.appendFileSync(path.join(a.publicDir, rel), ' ');
  fs.writeFileSync(path.join(a.sharedDir, 'note.txt'), 'x');
  fs.writeFileSync(path.join(a.publicDir, 'other.mjs'), 'x');
  assert.equal(computeBuild(a.publicDir, a.sharedDir), before);
  fs.rmSync(a.root, { recursive: true, force: true });
});

test('computeBuild：shared/ が無くても版は出る。public/ が読めなければ dev', () => {
  const a = makePublic();
  const missing = path.join(os.tmpdir(), 'asaso-nonexistent-shared');
  assert.match(computeBuild(a.publicDir, missing), /^[0-9a-f]{10}$/);
  fs.rmSync(a.sharedDir, { recursive: true, force: true });
  assert.match(computeBuild(a.publicDir, a.sharedDir), /^[0-9a-f]{10}$/);
  assert.equal(computeBuild(path.join(os.tmpdir(), 'asaso-nonexistent-dir'), a.sharedDir), 'dev');
  fs.rmSync(a.root, { recursive: true, force: true });
});
