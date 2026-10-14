import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { computeBuild, createRequestHandler, PUBLIC_DIR } from './http.js';
import { TopicPool } from './topics.js';

// 一時フォルダに、小さな public/ を作る。root/public と、名前が前方一致する root/public2 と、外の root/secret.txt も置く。
function makePublic(files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asaso-http-'));
  const publicDir = path.join(root, 'public');
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
  fs.mkdirSync(path.join(root, 'public2'));
  fs.writeFileSync(path.join(root, 'public2', 'x.txt'), 'sibling');
  fs.writeFileSync(path.join(root, 'secret.txt'), 'secret');
  return { root, publicDir };
}

async function serve(t, { files, adminToken = '' } = {}) {
  const { root, publicDir } = makePublic(files);
  const build = computeBuild(publicDir);
  const handler = createRequestHandler({ topics: new TopicPool(['A']), rooms: new Map(), build, startedAt: Date.now(), publicDir, adminToken });
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
  const v1 = computeBuild(a.publicDir);
  assert.match(v1, /^[0-9a-f]{10}$/);
  assert.equal(computeBuild(b.publicDir), v1);
  for (const f of ['index.html', 'app.js', 'style.css', 'howto.md']) {
    const before = computeBuild(a.publicDir);
    fs.appendFileSync(path.join(a.publicDir, f), ' ');
    assert.notEqual(computeBuild(a.publicDir), before, f);
  }
  const unrelated = computeBuild(b.publicDir);
  fs.appendFileSync(path.join(b.publicDir, 'data.bin'), ' '); // 版に含めないファイル
  assert.equal(computeBuild(b.publicDir), unrelated);
  fs.rmSync(a.root, { recursive: true, force: true });
  fs.rmSync(b.root, { recursive: true, force: true });
});

test('computeBuild：読めなければ dev。本物の public/ からは版が出る', () => {
  assert.equal(computeBuild(path.join(os.tmpdir(), 'asaso-nonexistent-dir')), 'dev');
  assert.match(computeBuild(PUBLIC_DIR), /^[0-9a-f]{10}$/);
});
