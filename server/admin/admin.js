// 管理ページ（/admin）。環境変数 ADMIN_TOKEN があるときだけ使える（未設定なら存在しないことにする）。
// 状況の確認と、報告・手入力の題材のリセットができる。合言葉は、ページの欄に入力する（URLには載せない）。

import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PAGE = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'admin.html'));
const digest = (s) => createHash('sha256').update(String(s)).digest();

export function tokenOk(given, expected) {
  if (!expected || typeof given !== 'string') return false;
  return timingSafeEqual(digest(given), digest(expected));
}

const json = (res, code, obj) => res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }).end(JSON.stringify(obj));

async function readBody(req) {
  let raw = '';
  for await (const c of req) { raw += c; if (raw.length > 10_000) throw new Error('too large'); }
  return raw ? JSON.parse(raw) : {};
}

// 戻り値 true = 扱った。ctx = { topics, rooms, build, startedAt }
export async function handleAdmin(req, res, url, ctx, token = process.env.ADMIN_TOKEN) {
  if (!url.pathname.startsWith('/admin')) return false;
  if (!token) { res.writeHead(404).end('not found'); return true; }

  if (url.pathname === '/admin' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' }).end(PAGE);
    return true;
  }
  if (req.method !== 'POST' || !url.pathname.startsWith('/admin/api/')) { res.writeHead(404).end('not found'); return true; }

  if (!tokenOk(req.headers['x-admin-token'], token)) {
    await new Promise((r) => setTimeout(r, 800)); // 総当たりを遅くする
    json(res, 401, { error: '合言葉が違います' });
    return true;
  }
  try {
    const body = await readBody(req);
    if (url.pathname === '/admin/api/status') {
      let players = 0;
      for (const { room } of ctx.rooms.values()) players += room.connectedCount();
      json(res, 200, {
        build: ctx.build,
        uptimeSec: Math.round((Date.now() - ctx.startedAt) / 1000),
        rooms: { count: ctx.rooms.size, connectedPlayers: players },
        topics: ctx.topics.stats(),
      });
      return true;
    }
    if (url.pathname === '/admin/api/addThemes') {
      const r = await ctx.topics.addThemes(body.text);
      json(res, 200, { ok: true, ...r, total: ctx.topics.stats().total, persisted: Boolean(ctx.topics.store && ctx.topics.ready) });
      return true;
    }
    if (url.pathname === '/admin/api/reset') {
      if (body.what === 'flags') { await ctx.topics.resetFlags(); json(res, 200, { ok: true }); return true; }
      if (body.what === 'userThemes') { const removed = await ctx.topics.removeUserThemes(); json(res, 200, { ok: true, removed }); return true; }
      json(res, 400, { error: '消す対象が正しくありません' });
      return true;
    }
    res.writeHead(404).end('not found');
  } catch (e) {
    json(res, 500, { error: String(e.message ?? e) });
  }
  return true;
}
