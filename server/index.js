// HTTP（public/ の配信）と WebSocket（部屋の操作と状態配信）。
// ゲームのルールは room.js が持ち、ここは受け付けと配信だけをする。

import http from 'node:http';
import { WebSocketServer } from 'ws';
import { RoomError } from './roles.js';
import { TopicPool } from './topics.js';
import { handleAct } from './actions.js';
import { createStoreFromEnv } from './store.js';
import { computeBuild, createRequestHandler } from './http.js';
import { Hub, send } from './hub.js';

const PORT = Number(process.env.PORT ?? 3000);
const TICK_MS = 1000;
const PING_MS = 25000;

const BUILD = computeBuild();

const startedAt = Date.now();
const hub = new Hub();
const topics = new TopicPool();
topics.attach(createStoreFromEnv()); // DATABASE_URL があれば、題材と報告を保存・読み込み。無ければ、メモリだけ（起動は待たない）

// ---------- HTTP ----------

const server = http.createServer(createRequestHandler({ topics, rooms: hub.rooms, build: BUILD, startedAt }));

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
    hub.attach(entry, pid, ws);
    send(ws, { t: 'joined', code, playerId: pid });
    hub.broadcast(entry);
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
        const { code, entry, player } = hub.createRoom(msg.name, msg.settings);
        attach(code, entry, player.id);
      } else if (msg.t === 'join') {
        const code = String(msg.code ?? '').trim().toUpperCase();
        const entry = hub.get(code);
        if (!entry) throw new RoomError('no_room', 'その部屋は見つかりません（閉じられた可能性があります）');
        const p = entry.room.join(msg.playerId, msg.name, Date.now(), { spectator: Boolean(msg.spectator) });
        attach(code, entry, p.id);
      } else if (msg.t === 'act') {
        const entry = hub.get(ctx.code);
        if (!entry || !ctx.pid) throw new RoomError('not_joined', '部屋に入っていません');
        const out = handleAct({ room: entry.room, topics, clientId: ctx.clientId }, ctx.pid, msg);
        if (out.needConfirm) {
          send(ws, { t: 'needConfirm', pending: out.needConfirm.pending, phase: out.needConfirm.phase });
          return;
        }
        if (out.closed) {
          hub.closeRoom(ctx.code, entry);
          return;
        }
        if (out.leave) {
          hub.leave(entry, ctx.pid);
          return;
        }
        if ('react' in out) {
          if (out.react) hub.sendReact(entry, out.react.kind);
          return;
        }
        hub.announce(entry, out.ev);
        hub.broadcast(entry);
      }
    } catch (e) {
      fail(e);
    }
  });

  ws.on('close', () => {
    const entry = hub.get(ctx.code);
    if (!entry || !ctx.pid) return;
    hub.detach(entry, ctx.pid, ws);
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
setInterval(() => hub.tick(), TICK_MS);

server.listen(PORT, () => console.log(`朝それ: http://localhost:${PORT}`));
