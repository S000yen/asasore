// 役割と権限まわりの判定（主催者／出題者／順番／後継者選び）。
// 状態そのものは room.js が持ち、ここは room を受け取って判定だけする。

import { randomInt } from 'node:crypto';

export class RoomError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RoomError';
    this.code = code;
  }
}

// 削除済み（removed）でない参加者だけを「参加者」とみなす。
export const isActive = (p) => Boolean(p) && !p.removed;

export function activePlayers(room) {
  return [...room.players.values()].filter(isActive);
}

export function connectedPlayers(room) {
  return activePlayers(room).filter((p) => p.connected);
}

export function getActive(room, id) {
  const p = room.players.get(id);
  if (!isActive(p)) throw new RoomError('no_such_player', '参加者が見つかりません');
  return p;
}

export function requireHost(room, id) {
  getActive(room, id);
  if (room.hostId !== id) throw new RoomError('not_host', '主催者のみ可能な操作です');
}

export function requirePresenter(room, id) {
  getActive(room, id);
  if (room.presenterId !== id) throw new RoomError('not_presenter', '出題者のみ可能な操作です');
}

// 出題者の指名・委譲ができるのは、主催者か、いまの出題者。
export function canAssignPresenter(room, id) {
  return id === room.hostId || id === room.presenterId;
}

// 主催者が落ちたときの後継者：接続中で一番早く参加した人。
export function pickSuccessor(room, excludeId) {
  const list = connectedPlayers(room)
    .filter((p) => p.id !== excludeId)
    .sort((a, b) => a.seq - b.seq);
  return list[0] ?? null;
}

// 順番方式の次の出題者。接続中でない人、削除済みの人は飛ばす。
export function pickNextInRotation(room) {
  const order = room.settings.order;
  if (order.length === 0) return null;
  const start = order.indexOf(room.rotationCursor); // 見つからなければ -1（先頭から）
  for (let i = 1; i <= order.length; i++) {
    const id = order[(start + i + order.length) % order.length];
    const p = room.players.get(id);
    if (isActive(p) && p.connected) return p;
  }
  return null;
}

export function pickRandomPresenter(room, excludeId) {
  const all = connectedPlayers(room);
  const pool = all.filter((p) => p.id !== excludeId);
  const list = pool.length > 0 ? pool : all;
  return list.length > 0 ? list[randomInt(list.length)] : null;
}

// 設定画面で並べ替えた順番を検証して整える。
// 指定に含まれなかった人は、元の並びのまま末尾に付ける。
export function normalizeOrder(room, order) {
  if (!Array.isArray(order)) throw new RoomError('bad_order', '順番の指定が正しくありません');
  const seen = new Set();
  const result = [];
  for (const id of order) {
    if (!room.players.has(id)) throw new RoomError('bad_order', '順番に知らない参加者が含まれています');
    if (!seen.has(id)) {
      seen.add(id);
      result.push(id);
    }
  }
  for (const id of room.settings.order) {
    if (!seen.has(id)) result.push(id);
  }
  return result;
}
