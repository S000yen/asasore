// WebSocket の接続1本ぶんの受け付け：入室（create / join）と、操作（act）の振り分け、切断の後始末。
// 誰に何を送るかは hub.js、操作の中身は actions.js、ゲームのルールは room.js が受け持つ。

import { WebSocketServer } from 'ws';
import { RoomError } from '../game/roles.js';
import { handleAct } from '../game/actions.js';
import { send } from './hub.js';
import { ERR, MSG } from '../../shared/protocol.js';

// 接続を1本受け付けて、メッセージを処理する。
export function handleConnection(ws, { hub, topics, build }) {
  const ctx = { code: null, pid: null, clientId: null }; // clientId: 端末ごとの匿名ID（同じ端末の報告を1回と数えるため）
  send(ws, { t: MSG.HELLO, build });
  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });

  const fail = (e) => {
    if (e instanceof RoomError) send(ws, { t: MSG.ERROR, code: e.code, message: e.message });
    else {
      console.error(e);
      send(ws, { t: MSG.ERROR, code: 'internal', message: 'サーバーでエラーが起きました' });
    }
  };

  const attach = (code, entry, pid) => {
    ctx.code = code;
    ctx.pid = pid;
    hub.attach(entry, pid, ws);
    send(ws, { t: MSG.JOINED, code, playerId: pid });
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
      if (msg.t === MSG.CREATE) {
        const { code, entry, player } = hub.createRoom(msg.name, msg.settings);
        attach(code, entry, player.id);
      } else if (msg.t === MSG.JOIN) {
        const code = String(msg.code ?? '').trim().toUpperCase();
        const entry = hub.get(code);
        if (!entry) throw new RoomError(ERR.NO_ROOM, 'その部屋は見つかりません（閉じられた可能性があります）');
        const p = entry.room.join(msg.playerId, msg.name, Date.now(), { spectator: Boolean(msg.spectator) });
        attach(code, entry, p.id);
      } else if (msg.t === MSG.ACT) {
        const entry = hub.get(ctx.code);
        if (!entry || !ctx.pid) throw new RoomError('not_joined', '部屋に入っていません');
        const out = handleAct({ room: entry.room, topics, clientId: ctx.clientId }, ctx.pid, msg);
        if (out.needConfirm) {
          send(ws, { t: MSG.NEED_CONFIRM, pending: out.needConfirm.pending, phase: out.needConfirm.phase });
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
}

export function createWebSocketServer({ server, hub, topics, build }) {
  const wss = new WebSocketServer({ server });
  wss.on('connection', (ws) => handleConnection(ws, { hub, topics, build }));
  return wss;
}

// 通信が切れた接続を検出する（スマホは黙って切れることが多い）。
// 定期的に呼ぶ。前回の ping に pong が返っていない接続は切り、それ以外には ping を送る。
export function pingClients(wss) {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}
