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

// 観戦中でない参加者（回答・投票・出題などの、ゲームに加わる人）
export const isGamePlayer = (p) => isActive(p) && !p.spectator;
export const gamePlayers = (room) => activePlayers(room).filter((p) => !p.spectator);
export const connectedGamePlayers = (room) => gamePlayers(room).filter((p) => p.connected);

export function getActive(room, id) {
  const p = room.players.get(id);
  if (!isActive(p)) throw new RoomError('no_such_player', '参加者が見つかりません');
  return p;
}

// ゲームに加わる人だけ（観戦中は、回答・投票などができない）
export function getPlayer(room, id) {
  const p = getActive(room, id);
  if (p.spectator) throw new RoomError('spectating', '観戦中はできません。参戦に切り替えてください');
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

// 担当者（出題者・選ぶ人）が、いま務められる状態か（参加していて、接続中）
// 出題者・選ぶ人は、観戦中の人でも務められる（接続中であればよい）
export const holderAvailable = (room, holderId) => {
  const p = room.players.get(holderId);
  return isActive(p) && p.connected;
};

// 担当の指名・委譲ができるのは、いまの担当者だけ。担当者が不在のときは、主催者に権限が戻る。
const canAssign = (room, id, holderId) => id === holderId || (id === room.hostId && !holderAvailable(room, holderId));
export const canAssignPresenter = (room, id) => canAssign(room, id, room.presenterId);
export const canAssignChooser = (room, id) => canAssign(room, id, room.chooserId);

// 主催者が落ちたときの後継者：接続中で一番早く参加した人。
export function pickSuccessor(room, excludeId) {
  const list = connectedPlayers(room)
    .filter((p) => p.id !== excludeId)
    .sort((a, b) => (a.spectator ? 1 : 0) - (b.spectator ? 1 : 0) || a.seq - b.seq); // 参戦中の人を先に（観戦しかいなければ、その人が主催者になり参戦に切り替わる）
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
    if (isGamePlayer(p) && p.connected) return p;
  }
  return null;
}

// ランダム指名（出題者・選ぶ人）。本人も含めた、接続中で参戦中の全員から選ぶ。
export function pickRandomPlayer(room) {
  const all = connectedGamePlayers(room);
  return all.length > 0 ? all[randomInt(all.length)] : null;
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
