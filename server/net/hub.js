// 部屋の一覧と、部屋ごとの接続（WebSocket）への配信。
// ゲームのルールは room.js が持ち、ここは「誰に、何を送るか」だけを受け持つ。
//
// entry = { room, sockets: Map<playerId, Set<ws>> }。同じ人が複数の画面（タブ）で開いていることがあるので、接続は集合で持つ。

import { randomInt } from 'node:crypto';
import { Room } from '../game/room.js';
import { describe } from '../game/messages.js';
import { MSG } from '../../shared/protocol.js';
import { ROOM_CODE_LENGTH } from '../../shared/rules.js';

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 紛らわしい文字（I, O, 0, 1）を除く

// 切れている接続には送らない
export const send = (ws, msg) => {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
};

export class Hub {
  constructor() {
    this.rooms = new Map(); // code -> entry
  }

  get(code) {
    return this.rooms.get(code);
  }

  newCode() {
    for (;;) {
      let code = '';
      for (let i = 0; i < ROOM_CODE_LENGTH; i++) code += CODE_CHARS[randomInt(CODE_CHARS.length)];
      if (!this.rooms.has(code)) return code;
    }
  }

  // 部屋を作り、作った人を主催者として入室させる。
  // settings は作成前に選んだ設定。不正な値は無視して、既定のまま作る。
  createRoom(name, settings) {
    const code = this.newCode();
    const room = new Room(code);
    const entry = { room, sockets: new Map() };
    const player = room.join(null, name);
    if (settings && typeof settings === 'object') {
      const { presenterMode, identityMode, chooserMode, timeLimit } = settings;
      try { room.setSettings(player.id, { presenterMode, identityMode, chooserMode, timeLimit }); } catch { /* 既定のまま */ }
    }
    this.rooms.set(code, entry);
    return { code, entry, player };
  }

  // 入室した人の接続を登録する
  attach(entry, pid, ws) {
    if (!entry.sockets.has(pid)) entry.sockets.set(pid, new Set());
    entry.sockets.get(pid).add(ws);
  }

  // 接続が切れた。その人の接続が全部なくなったら、離席にして、ほかの人に知らせる。
  detach(entry, pid, ws) {
    const set = entry.sockets.get(pid);
    if (!set) return;
    set.delete(ws);
    if (set.size === 0) {
      entry.sockets.delete(pid);
      entry.room.disconnect(pid);
      this.broadcast(entry);
    }
  }

  // 自分の意思での退出。その人の接続を全部閉じ、ほかの人に知らせる。（room.leave は呼び出し側が済ませておく）
  leave(entry, pid) {
    for (const ws of entry.sockets.get(pid) ?? []) {
      send(ws, { t: MSG.LEFT });
      ws.close();
    }
    entry.sockets.delete(pid);
    this.broadcast(entry);
  }

  // 参加者ごとに、その人用のビューを送る（匿名モードの作者はここでも出さない）。
  // 外された人には removed を送って、接続を閉じる。
  broadcast(entry) {
    for (const [pid, set] of [...entry.sockets]) {
      let view;
      try {
        view = entry.room.viewFor(pid);
      } catch {
        for (const ws of set) {
          send(ws, { t: MSG.REMOVED });
          ws.close();
        }
        entry.sockets.delete(pid);
        continue;
      }
      for (const ws of set) send(ws, { t: MSG.STATE, view });
    }
  }

  notifyAll(entry, text) {
    for (const set of entry.sockets.values()) for (const ws of set) send(ws, { t: MSG.NOTICE, text });
  }

  // 部屋で起きたイベントを、通知文にして全員に出す（通知のないイベントは何もしない）
  announce(entry, ev) {
    const text = describe(entry.room, ev);
    if (text) this.notifyAll(entry, text);
  }

  // 反応マークは、状態を変えず、全員に流すだけ
  sendReact(entry, kind) {
    for (const set of entry.sockets.values()) for (const ws of set) send(ws, { t: MSG.REACT, kind });
  }

  closeRoom(code, entry) {
    for (const set of entry.sockets.values()) for (const ws of set) send(ws, { t: MSG.CLOSED });
    this.rooms.delete(code);
  }

  // 定期的に呼ぶ。猶予を過ぎた主催者・出題者の引き継ぎと、空き部屋の終了をする。
  tick() {
    for (const [code, entry] of [...this.rooms]) {
      const events = entry.room.tick();
      if (entry.room.closed) {
        this.closeRoom(code, entry);
        continue;
      }
      for (const ev of events) this.announce(entry, ev);
      if (events.length > 0) this.broadcast(entry);
    }
  }
}
