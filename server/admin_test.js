import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { handleAdmin, tokenOk } from './admin.js';
import { TopicPool } from './topics.js';

test('合言葉の判定', () => {
  assert.equal(tokenOk('abc', 'abc'), true);
  assert.equal(tokenOk('abd', 'abc'), false);
  assert.equal(tokenOk(undefined, 'abc'), false);
  assert.equal(tokenOk('abc', ''), false);
});

function serve(token) {
  const topics = new TopicPool(['A', 'B']);
  const ctx = { topics, rooms: new Map(), build: 'test', startedAt: Date.now() };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (!(await handleAdmin(req, res, url, ctx, token))) res.writeHead(404).end('other');
  });
  return new Promise((r) => server.listen(0, () => r({ server, topics, base: `http://127.0.0.1:${server.address().port}` })));
}
const post = (base, p, token, body = {}) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { 'x-admin-token': token } : {}) }, body: JSON.stringify(body) });

test('管理ページ：ADMIN_TOKEN が無ければ存在しない。あれば合言葉が要る', async () => {
  let s = await serve('');
  assert.equal((await fetch(s.base + '/admin')).status, 404);
  assert.equal((await post(s.base, '/admin/api/status', 'x')).status, 404);
  s.server.close();

  s = await serve('secret');
  assert.equal((await fetch(s.base + '/admin')).status, 200);
  assert.equal((await post(s.base, '/admin/api/status', 'wrong')).status, 401);
  assert.equal((await post(s.base, '/admin/api/status', null)).status, 401);
  const ok = await post(s.base, '/admin/api/status', 'secret');
  assert.equal(ok.status, 200);
  const j = await ok.json();
  assert.equal(j.topics.total, 2); assert.equal(j.rooms.count, 0);
  s.topics.flag('A', 'c1');
  assert.equal((await post(s.base, '/admin/api/reset', 'wrong', { what: 'flags' })).status, 401);
  assert.equal(s.topics.stats().flags, 1); // 合言葉が違えば、消えない
  assert.equal((await post(s.base, '/admin/api/reset', 'secret', { what: 'flags' })).status, 200);
  assert.equal(s.topics.stats().flags, 0);
  assert.equal((await post(s.base, '/admin/api/reset', 'secret', { what: 'x' })).status, 400);
  s.server.close();
});
