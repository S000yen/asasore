// HTTP（public/ の配信）と WebSocket（部屋の操作と状態配信）。
// ゲームのルールは room.js が持ち、ここは受け付けと配信だけをする。

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomInt, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { WebSocketServer } from 'ws';
import { Room } from './room.js';
import { RoomError } from './roles.js';
import { TopicPool } from './topics.js';
import { handleAdmin } from './admin.js';
import { describe } from './messages.js';
import { handleAct } from './actions.js';
import { createStoreFromEnv } from './store.js';

const PORT = Number(process.env.PORT ?? 3000);
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 紛らわしい文字（I, O, 0, 1）を除く
const TICK_MS = 1000;
const PING_MS = 25000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

// 配信するファイルの版（中身から決める）。開きっぱなしの古い画面が、再接続のときに気づいて自分で読み込み直すために使う。
const BUILD = (() => {
  try {
    const h = createHash('sha1');
    for (const f of ['index.html', 'app.js', 'style.css', 'howto.md']) h.update(readFileSync(path.join(PUBLIC_DIR, f)));
    return h.digest('hex').slice(0, 10);
  } catch { return 'dev'; }
})();

const startedAt = Date.now();
const rooms = new Map(); // code -> { room, sockets: Map<playerId, Set<ws>> }
const topics = new TopicPool();
topics.attach(createStoreFromEnv()); // DATABASE_URL があれば、題材と報告を保存・読み込み。無ければ、メモリだけ（起動は待たない）

// ---------- HTTP ----------

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/health') { // 動作確認と、休止からの復帰・定期アクセス用
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }).end('ok');
      return;
    }
    if (await handleAdmin(req, res, url, { topics, rooms, build: BUILD, startedAt })) return;
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!file.startsWith(PUBLIC_DIR + path.sep)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    let body = await readFile(file);
    if (path.basename(file) === 'index.html') body = Buffer.from(body.toString('utf8').replace('</head>', `  <meta name="build" content="${BUILD}">\n</head>`));
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});

// ---------- 配信 ----------

const send = (ws, msg) => {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
};

function newCode() {
  for (;;) {
    let code = '';
    for (let i = 0; i < 4; i++) code += CODE_CHARS[randomInt(CODE_CHARS.length)];
    if (!rooms.has(code)) return code;
  }
}

// 参加者ごとに、その人用のビューを送る（匿名モードの作者はここでも出さない）。
function broadcast(entry) {
  for (const [pid, set] of [...entry.sockets]) {
    let view;
    try {
      view = entry.room.viewFor(pid);
    } catch {
      for (const ws of set) {
        send(ws, { t: 'removed' });
        ws.close();
      }
      entry.sockets.delete(pid);
      continue;
    }
    for (const ws of set) send(ws, { t: 'state', view });
  }
}

function notifyAll(entry, text) {
  for (const set of entry.sockets.values()) for (const ws of set) send(ws, { t: 'notice', text });
}

function closeRoom(code, entry) {
  for (const set of entry.sockets.values()) for (const ws of set) send(ws, { t: 'closed' });
  rooms.delete(code);
}

// ---------- WebSocket ----------

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  const ctx = { code: null, pid: null, clientId: null }; // clientId: 端末ごとの匿名ID（同じ端末の報告を1回と数えるため）
  send(ws, { t: 'hello', build: BUILD });
  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });

  const fail = (e) => {
    if (e instanceof RoomError) send(ws, { t: 'error', code: e.code, message: e.message });
    else {
      console.error(e);
      send(ws, { t: 'error', code: 'internal', message: 'サーバーでエラーが起きました' });
    }
  };

  const attach = (code, entry, pid) => {
    ctx.code = code;
    ctx.pid = pid;
    if (!entry.sockets.has(pid)) entry.sockets.set(pid, new Set());
    entry.sockets.get(pid).add(ws);
    send(ws, { t: 'joined', code, playerId: pid });
    broadcast(entry);
  };

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (typeof msg.clientId === 'string' && /^[\w-]{8,64}$/.test(msg.clientId)) ctx.clientId = msg.clientId;
    try {
      if (msg.t === 'create') {
        const code = newCode();
        const room = new Room(code);
        const entry = { room, sockets: new Map() };
        const p = room.join(null, msg.name);
        if (msg.settings && typeof msg.settings === 'object') { // 作成前に選んだ設定。不正な値は無視して、既定のまま作る
          const { presenterMode, identityMode, chooserMode, timeLimit } = msg.settings;
          try { room.setSettings(p.id, { presenterMode, identityMode, chooserMode, timeLimit }); } catch { /* 既定のまま */ }
        }
        rooms.set(code, entry);
        attach(code, entry, p.id);
      } else if (msg.t === 'join') {
        const code = String(msg.code ?? '').trim().toUpperCase();
        const entry = rooms.get(code);
        if (!entry) throw new RoomError('no_room', 'その部屋は見つかりません（閉じられた可能性があります）');
        const p = entry.room.join(msg.playerId, msg.name, Date.now(), { spectator: Boolean(msg.spectator) });
        attach(code, entry, p.id);
      } else if (msg.t === 'act') {
        const entry = rooms.get(ctx.code);
        if (!entry || !ctx.pid) throw new RoomError('not_joined', '部屋に入っていません');
        const out = handleAct({ room: entry.room, topics, clientId: ctx.clientId }, ctx.pid, msg);
        if (out.needConfirm) {
          send(ws, { t: 'needConfirm', pending: out.needConfirm.pending, phase: out.needConfirm.phase });
          return;
        }
        if (out.closed) {
          closeRoom(ctx.code, entry);
          return;
        }
        if (out.leave) {
          const set = entry.sockets.get(ctx.pid);
          for (const s of set ?? []) {
            send(s, { t: 'left' });
            s.close();
          }
          entry.sockets.delete(ctx.pid);
          broadcast(entry);
          return;
        }
        if ('react' in out) {
          if (out.react) for (const set of entry.sockets.values()) for (const w of set) send(w, { t: 'react', kind: out.react.kind });
          return;
        }
        const text = describe(entry.room, out.ev);
        if (text) notifyAll(entry, text);
        broadcast(entry);
      }
    } catch (e) {
      fail(e);
    }
  });

  ws.on('close', () => {
    const entry = rooms.get(ctx.code);
    if (!entry || !ctx.pid) return;
    const set = entry.sockets.get(ctx.pid);
    if (!set) return;
    set.delete(ws);
    if (set.size === 0) {
      entry.sockets.delete(ctx.pid);
      entry.room.disconnect(ctx.pid);
      broadcast(entry);
    }
  });
});

// 通信が切れた接続を検出する（スマホは黙って切れることが多い）
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, PING_MS);

// 猶予を過ぎた主催者・出題者の引き継ぎと、空き部屋の終了
setInterval(() => {
  for (const [code, entry] of [...rooms]) {
    const events = entry.room.tick();
    if (entry.room.closed) {
      closeRoom(code, entry);
      continue;
    }
    for (const ev of events) {
      const text = describe(entry.room, ev);
      if (text) notifyAll(entry, text);
    }
    if (events.length > 0) broadcast(entry);
  }
}, TICK_MS);

server.listen(PORT, () => console.log(`朝それ: http://localhost:${PORT}`));
