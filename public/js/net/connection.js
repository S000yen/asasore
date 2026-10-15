// サーバーとの接続（WebSocket）：接続と再接続、送信、入室の送信、返事がないときの再送。

import { requestRender, toast } from '../core/hooks.js';
import { state, ui } from '../core/state.js';
import { clientId } from './storage.js';
import { MSG } from '../../../shared/protocol.js';

let ws = null;
let backoff = 500;

// 招待リンク（/?code=XXXX）から開いたら、コードも名前も入れずに、そのまま入る（startConnection で読む）
let pendingLink = null;
const readPendingLink = () => {
  const c = (new URLSearchParams(location.search).get('code') ?? '').trim().toUpperCase();
  return /^[A-Z0-9]{4}$/.test(c) ? c : null;
};

// サーバーから届いたメッセージの処理（messages.js の onMessage）。起動時に main.js が登録する。
let messageHandler = () => {};

export const setMessageHandler = (fn) => { messageHandler = fn; };

function connect() {
  if (ws && ws.readyState <= 1) return;
  const sock = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`);
  ws = sock;
  sock.onopen = () => {
    backoff = 500;
    ui.connected = true;
    if (resend) { const m = resend; resend = null; sock.send(JSON.stringify(m)); }
    else if (pendingLink) joinFromLink();
    else if (state.session && state.autoJoin) sendJoin(state.session.code);
    requestRender();
  };
  sock.onmessage = (e) => {
    try { messageHandler(JSON.parse(e.data)); } catch (err) { console.error(err); }
  };
  sock.onclose = () => {
    if (ws !== sock) return; // つなぎ直しで自分から閉じたものは、無視する
    ws = null;
    ui.connected = false;
    requestRender();
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 5000);
  };
}

const sendRaw = (m) => {
  if (ws && ws.readyState === 1) { ws.send(JSON.stringify(m)); return true; }
  toast('接続しています。少し待ってから、もう一度お試しください');
  return false;
};
// 入室・作成のように、返事がないと困る操作。つながっているように見えて実は切れていた（スマホで起きやすい）ときは、
// 少し待って返事がなければ、つなぎ直して一度だけ送り直す。押したのに何も起きない、をなくす。
let resend = null;
let awaiting = null;
export function sendCritical(m) {
  if (!sendRaw(m)) return false;
  clearTimeout(awaiting?.timer);
  awaiting = { m, tries: 0, timer: setTimeout(retryCritical, 2500) };
  return true;
}
export function settleCritical() { clearTimeout(awaiting?.timer); awaiting = null; resend = null; }
function retryCritical() {
  const a = awaiting;
  if (!a) return;
  if (a.tries >= 1) { settleCritical(); ui.joining = false; toast('つながりませんでした。もう一度お試しください'); requestRender(); return; }
  a.tries += 1;
  resend = a.m;
  const old = ws;
  ws = null;
  ui.connected = false;
  try { old?.close(); } catch { /* すでに切れている */ }
  connect();
  a.timer = setTimeout(retryCritical, 5000);
}
export const act = (a, extra = {}) => sendRaw({ t: MSG.ACT, a, ...extra });

// 同じ端末で前に入った部屋なら、同じ参加者として戻る（playerId を渡す）
export function sendJoin(code, spectator = false) {
  state.lastJoinCode = code;
  return sendCritical({ t: MSG.JOIN, code, name: state.prefName, clientId, spectator, playerId: state.session?.code === code ? state.session.playerId : null });
}

function joinFromLink() {
  const code = pendingLink;
  pendingLink = null;
  try { history.replaceState(null, '', location.pathname); } catch { /* 書き換えられなくても動く */ }
  state.autoJoin = true;
  ui.joining = true;
  sendJoin(code);
}

// スマホはアプリを切り替えると通信が止まる。戻ってきたら接続を確かめ、入り直して最新の状態をもらう。
function wake() {
  if (document.hidden) return;
  if (!ws || ws.readyState > 1) { connect(); return; }
  if (state.view && state.session) sendJoin(state.session.code);
}

// 接続を始める（起動時に1回）。アプリに戻ってきたときに、つなぎ直す仕組みも、ここで登録する。
export function startConnection() {
  pendingLink = readPendingLink();
  document.addEventListener('visibilitychange', wake);
  window.addEventListener('online', wake);
  window.addEventListener('pageshow', wake);
  connect();
}
