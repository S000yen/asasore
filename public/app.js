'use strict';

// ---------- 状態 ----------

const STORE = 'asaso.session';
const CLIENT_STORE = 'asaso.client'; // この端末の匿名ID。「おかしい」の報告を、端末ごとに1回と数えるために使う
const NAME_STORE = 'asaso.name'; // 自分で付けた表示名（次の部屋でも使う）。未設定なら、部屋ごとに「ユーザーN」になる
const INPUT_IDS = ['codeInput', 'renameInput', 'answerInput', 'hiraInput', 'themeInput'];
const $app = document.getElementById('app');

const loadSession = () => {
  try { return JSON.parse(localStorage.getItem(STORE)); } catch { return null; }
};
const saveSession = (s) => {
  try { s ? localStorage.setItem(STORE, JSON.stringify(s)) : localStorage.removeItem(STORE); } catch { /* 保存できなくても動く */ }
};
const loadName = () => {
  try { return localStorage.getItem(NAME_STORE) ?? ''; } catch { return ''; }
};
const saveName = (n) => {
  try { localStorage.setItem(NAME_STORE, n); } catch { /* 保存できなくても動く */ }
};

const clientId = (() => {
  try {
    let id = localStorage.getItem(CLIENT_STORE);
    if (!id) {
      id = (crypto.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`);
      localStorage.setItem(CLIENT_STORE, id);
    }
    return id;
  } catch { return null; } // 保存できない端末では、IDなし（サーバー側で参加者ごとに数える）
})();

let ws = null;
let viewAt = 0;             // 状態を受け取った時刻（経過時間の表示用）
let view = null;            // サーバーから届いた自分用の状態
let session = loadSession(); // { code, playerId }（端末に残す。再接続で同じ参加者として戻るため）
let prefName = loadName();   // 自分で決めた表示名。空ならサーバーが「ユーザーN」を付ける
let autoJoin = true;
let backoff = 500;
let endMessage = null;       // 入室画面の代わりに出す案内（外された、部屋が閉じた、など）
let lastJoinCode = null;     // 最後に入ろうとした部屋（見つからなかったとき、どの記録を消すか決めるため）

// 招待リンク（/?code=XXXX）から開いたら、コードも名前も入れずに、そのまま入る
let pendingLink = (() => {
  const c = (new URLSearchParams(location.search).get('code') ?? '').trim().toUpperCase();
  return /^[A-Z0-9]{4}$/.test(c) ? c : null;
})();
const newRoom = { presenterMode: 'host', identityMode: 'named', chooserMode: 'all', timeLimit: 0 }; // 部屋をつくるときの設定（作成の前に選ぶ）
const ui = { joinWatch: false, editing: false, sel: new Set(), createOpen: false, sheet: null, modal: null, toast: null, connected: false, joinOpen: false, joining: false, pendingRename: null };
const drafts = { code: '', rename: '', answer: '', hiragana: '', theme: '' };
let lastRound = 0, lastTopicKey = '', autoDrawKey = '';
let composing = false, pendingRender = false, toastTimer = null;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- 通信 ----------

function connect() {
  if (ws && ws.readyState <= 1) return;
  const sock = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`);
  ws = sock;
  sock.onopen = () => {
    backoff = 500;
    ui.connected = true;
    if (resend) { const m = resend; resend = null; sock.send(JSON.stringify(m)); }
    else if (pendingLink) joinFromLink();
    else if (session && autoJoin) sendJoin(session.code);
    render();
  };
  sock.onmessage = (e) => {
    try { onMessage(JSON.parse(e.data)); } catch (err) { console.error(err); }
  };
  sock.onclose = () => {
    if (ws !== sock) return; // つなぎ直しで自分から閉じたものは、無視する
    ws = null;
    ui.connected = false;
    render();
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
function sendCritical(m) {
  if (!sendRaw(m)) return false;
  clearTimeout(awaiting?.timer);
  awaiting = { m, tries: 0, timer: setTimeout(retryCritical, 2500) };
  return true;
}
function settleCritical() { clearTimeout(awaiting?.timer); awaiting = null; resend = null; }
function retryCritical() {
  const a = awaiting;
  if (!a) return;
  if (a.tries >= 1) { settleCritical(); ui.joining = false; toast('つながりませんでした。もう一度お試しください'); render(); return; }
  a.tries += 1;
  resend = a.m;
  const old = ws;
  ws = null;
  ui.connected = false;
  try { old?.close(); } catch { /* すでに切れている */ }
  connect();
  a.timer = setTimeout(retryCritical, 5000);
}
const act = (a, extra = {}) => sendRaw({ t: 'act', a, ...extra });

// 同じ端末で前に入った部屋なら、同じ参加者として戻る（playerId を渡す）
function sendJoin(code, spectator = false) {
  lastJoinCode = code;
  return sendCritical({ t: 'join', code, name: prefName, clientId, spectator, playerId: session?.code === code ? session.playerId : null });
}

function joinFromLink() {
  const code = pendingLink;
  pendingLink = null;
  try { history.replaceState(null, '', location.pathname); } catch { /* 書き換えられなくても動く */ }
  autoJoin = true;
  ui.joining = true;
  sendJoin(code);
}

// スマホはアプリを切り替えると通信が止まる。戻ってきたら接続を確かめ、入り直して最新の状態をもらう。
function wake() {
  if (document.hidden) return;
  if (!ws || ws.readyState > 1) { connect(); return; }
  if (view && session) sendJoin(session.code);
}
document.addEventListener('visibilitychange', wake);
window.addEventListener('online', wake);
window.addEventListener('pageshow', wake);

function onMessage(m) {
  switch (m.t) {
    case 'hello': { // 開きっぱなしの古い画面は、新しい版が出ていたら、自分で読み込み直す
      const mine = document.querySelector('meta[name=build]')?.content;
      if (mine && m.build && mine !== m.build) location.reload();
      return;
    }
    case 'joined':
      settleCritical();
      session = { code: m.code, playerId: m.playerId };
      saveSession(session);
      endMessage = null;
      ui.joinOpen = false;
      return;
    case 'state':
      view = m.view;
      viewAt = performance.now();
      ui.joining = false;
      if (ui.pendingRename !== null && view.me.name === ui.pendingRename) { // 表示名の変更が通った
        prefName = ui.pendingRename;
        saveName(prefName);
        ui.pendingRename = null;
        if (ui.sheet?.kind === 'rename') ui.sheet = null;
        toast('表示名を変えました');
      }
      syncDrafts();
      break;
    case 'notice':
      toast(m.text);
      return;
    case 'react':
      floatMark(m.kind);
      return;
    case 'error':
      settleCritical();
      ui.joining = false;
      ui.pendingRename = null;
      if (m.code === 'no_room') { // 見つからなかった部屋の記録だけを消す（別の部屋の記録は残す）
        if (!session || session.code === lastJoinCode) { session = null; saveSession(null); }
        view = null;
      }
      if (m.code === 'banned') {
        view = null; autoJoin = false;
        endMessage = { title: 'この部屋には入れません', body: '主催者が再入室を許可すると、もう一度入れます。', retry: true };
      }
      toast(m.message);
      break;
    case 'needConfirm':
      ui.modal = confirmFor(m);
      break;
    case 'removed':
      view = null; autoJoin = false; ui.sheet = null; ui.modal = null;
      endMessage = { title: '部屋から外されました', body: '主催者が再入室を許可すると、もう一度入れます。', retry: true };
      break;
    case 'closed':
      view = null; session = null; saveSession(null); ui.sheet = null; ui.modal = null;
      endMessage = { title: '部屋が閉じられました', body: '' };
      break;
    case 'left':
      view = null; autoJoin = false; ui.sheet = null; ui.modal = null;
      break;
  }
  render();
}

// 入力中の内容（下書き）は、状態が届いても消さない。新しいラウンドと、お題が変わったときだけ入れ替える。
function syncDrafts() {
  const v = view;
  if (v.round !== lastRound) { lastRound = v.round; drafts.answer = ''; }
  if (v.phase === 'answer' && v.myAnswer !== null && drafts.answer === '') drafts.answer = v.myAnswer;
  if (v.phase === 'topic' && v.me.isPresenter) {
    const key = `${v.round}:${v.presenterId}:${JSON.stringify(v.topic)}`;
    if (key !== lastTopicKey) {
      lastTopicKey = key;
      drafts.hiragana = v.topic?.hiragana ?? '';
      drafts.theme = v.topic?.theme ?? '';
    }
    const dk = `${v.round}:${v.presenterId}`;
    if (!v.topic && autoDrawKey !== dk) { // 出題者になったら、まず全部ランダムで出しておく
      autoDrawKey = dk;
      act('drawTopic', { part: 'both' });
    }
  }
}

function toast(text) {
  ui.toast = text;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { ui.toast = null; render(); }, 3500);
  render();
}

function confirmFor(m) {
  const p = m.pending;
  let body;
  if (m.phase === 'answer') body = `まだ${p.count}人が未回答です（${p.names.join('、')}）。このまま進みますか？`;
  else if (m.phase === 'reveal') body = `まだ開示されていない回答が${p.count}件あります。このまま投票に進みますか？`;
  else if (view.settings.chooserMode === 'one') body = `まだ正解が選ばれていません（${p.names.join('、')}）。このまま結果を出しますか？`;
  else body = `まだ${p.count}人が未投票です（${p.names.join('、')}）。このまま結果を出しますか？`;
  return { body, ok: '進める', onOk: () => act('advance', { force: true }) };
}

// ---------- 描画 ----------

// 投票のはじまりで、背景を紺に反転し、「投票スタート」の帯を一瞬出す。帯は #app の外に置く（描画のたびに作り直されて、動きが途切れないように）。
// 主催者の「まとめを編集」中か。編集中は、完了するまで他の操作ができない。
const canEditGroups = () => Boolean(view?.me.isHost && ['reveal', 'vote'].includes(view.phase) && view.pool.filter((c) => c.revealed).length >= 2);
const isEditing = () => ui.editing && canEditGroups();
let lastPhaseKey = '';
function trackPhase() {
  const phase = view?.phase ?? '';
  document.body.dataset.phase = phase;
  const key = view ? `${view.code}:${view.round}:${phase}` : '';
  if (key !== lastPhaseKey) {
    ui.sel.clear(); // 段階が変わったら、編集と選択は解く
    ui.editing = false;
    if (view?.bombed && (phase === 'reveal' || phase === 'result') && lastPhaseKey.endsWith(':answer')) bomb();
    if (phase === 'vote' && lastPhaseKey.endsWith(':reveal')) startBand();
    if (phase === 'result' && lastPhaseKey.endsWith(':vote') && view.result?.winners.length) confetti();
    lastPhaseKey = key;
  }
  if (!isEditing()) { ui.editing = false; ui.sel.clear(); }
  if (view && ui.sel.size) { // 消えた・まだ開示されていない回答は、選択から外す
    const ok = new Set(view.pool.filter((c) => c.revealed).map((c) => c.answerId));
    for (const id of [...ui.sel]) if (!ok.has(id)) ui.sel.delete(id);
  }
}
// 結果の発表：画面の下の左右から、クラッカーのように紙吹雪が飛び出す。#app の外の canvas に描く（描画のたびに消されないように）。
function confetti() {
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
  document.querySelector('.confetti')?.remove();
  const cv = document.createElement('canvas');
  cv.className = 'confetti';
  cv.setAttribute('aria-hidden', 'true');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const W = window.innerWidth, H = window.innerHeight;
  cv.width = W * dpr; cv.height = H * dpr;
  document.body.append(cv);
  const g = cv.getContext('2d');
  g.scale(dpr, dpr);
  const colors = ['#ffd83d', '#d93a2b', '#16213a', '#ffffff', '#ff8a3d', '#4aa8d8'];
  const parts = [];
  const shoot = (fromLeft, delay) => {
    for (let i = 0; i < 70; i++) {
      const spread = (Math.random() - 0.5) * 0.7; // 扇のように広がる
      const ang = (fromLeft ? -Math.PI * 0.36 : -Math.PI * 0.64) + spread;
      const sp = (0.55 + Math.random() * 0.6) * Math.min(1500, H * 1.55);
      parts.push({
        x: fromLeft ? W * 0.06 : W * 0.94, y: H + 8, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp,
        w: 6 + Math.random() * 6, h: 3 + Math.random() * 4, rot: Math.random() * 6.28, vr: (Math.random() - 0.5) * 18,
        c: colors[(Math.random() * colors.length) | 0], round: Math.random() < 0.25, life: 2.2 + Math.random() * 1.2, age: -delay,
      });
    }
  };
  shoot(true, 0); shoot(false, 0); shoot(true, 0.28); shoot(false, 0.28);
  let last = performance.now();
  const step = (now) => {
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    g.clearRect(0, 0, W, H);
    let alive = 0;
    for (const p of parts) {
      p.age += dt;
      if (p.age < 0) { alive += 1; continue; }
      if (p.age > p.life) continue;
      alive += 1;
      p.vx *= Math.pow(0.12, dt); p.vy = p.vy * Math.pow(0.12, dt) + 820 * dt; // 空気の抵抗と重力
      p.x += p.vx * dt; p.y += p.vy * dt; p.rot += p.vr * dt;
      g.globalAlpha = Math.min(1, (p.life - p.age) / (p.life * 0.3));
      g.fillStyle = p.c;
      g.save(); g.translate(p.x, p.y); g.rotate(p.rot);
      if (p.round) { g.beginPath(); g.arc(0, 0, p.h, 0, 6.28); g.fill(); }
      else g.fillRect(-p.w / 2, -p.h / 2, p.w, p.h * Math.abs(Math.cos(p.rot * 1.7) * 0.8 + 0.2));
      g.restore();
    }
    if (alive) requestAnimationFrame(step); else cv.remove();
  };
  requestAnimationFrame(step);
}

// 反応マーク：画面の下から、ふわっと浮かび上がる。#app の外に出す（描画のたびに消えないように）。
const MARKS = { like: '👍', bad: '👎', cheer: '📣', laugh: '😂' };
function floatMark(kind) {
  const mark = MARKS[kind];
  if (!mark) return;
  let box = document.querySelector('.floaters');
  if (!box) { box = document.createElement('div'); box.className = 'floaters'; box.setAttribute('aria-hidden', 'true'); document.body.append(box); }
  if (box.childElementCount > 60) box.firstElementChild.remove();
  const el = document.createElement('span');
  el.className = 'float';
  el.textContent = mark;
  el.style.left = `${8 + Math.random() * 84}%`;
  el.style.setProperty('--sway', `${Math.round((Math.random() - 0.5) * 80)}px`);
  el.style.setProperty('--rise', `${55 + Math.round(Math.random() * 25)}vh`);
  el.style.fontSize = `${28 + Math.round(Math.random() * 14)}px`;
  el.addEventListener('animationend', () => el.remove());
  box.append(el);
}
function reactBarHtml() {
  const lock = isEditing();
  return `<div class="reactbar">${Object.entries(MARKS).map(([k, m]) => `<button class="react" ${lock ? 'disabled' : `data-do="react" data-kind="${k}"`} aria-label="${{ like: 'いいね', bad: 'バッド', cheer: '応援', laugh: '笑い' }[k]}">${m}</button>`).join('')}</div>`;
}

function startBand() {
  document.querySelector('.startband')?.remove();
  const el = document.createElement('div');
  el.className = 'startband';
  el.setAttribute('aria-hidden', 'true');
  el.innerHTML = `<span>${view.settings.chooserMode === 'one' ? '正解を選べ' : '投票スタート'}</span>`;
  document.body.append(el);
  setTimeout(() => el.remove(), 1700);
}

// 時間切れで、未回答の人がいたまま進んだとき：爆弾が爆発する
function bomb() {
  document.querySelector('.bomb')?.remove();
  const el = document.createElement('div');
  el.className = 'bomb';
  el.setAttribute('aria-hidden', 'true');
  el.innerHTML = '<div class="flash"></div><div class="boom">💥</div><div class="boomtext">時間切れ！</div>';
  document.body.append(el);
  document.body.classList.add('shake');
  setTimeout(() => document.body.classList.remove('shake'), 700);
  setTimeout(() => el.remove(), 2100);
}

function render() {
  if (composing) { pendingRender = true; return; } // 日本語入力の変換中は作り直さない
  trackPhase();
  morphInto($app, view ? roomHtml() : entryHtml());
  fitTheme();
}

// 画面の更新は、全部を作り直さず、変わったところだけを書き換える。
// スクロール位置、入力中の欄（キーボード）、動いている演出が、他の人の操作で途切れないように。
function morphInto(root, html) {
  const next = document.createElement('div');
  next.innerHTML = html;
  syncChildren(root, next);
}
function syncChildren(parent, fresh) {
  const want = fresh.childNodes;
  for (let i = 0; i < want.length; i++) {
    const n = want[i], o = parent.childNodes[i];
    if (!o) { parent.appendChild(n.cloneNode(true)); continue; }
    if (o.nodeType !== n.nodeType || o.nodeName !== n.nodeName) { parent.replaceChild(n.cloneNode(true), o); continue; }
    if (n.nodeType !== 1) { if (o.nodeValue !== n.nodeValue) o.nodeValue = n.nodeValue; continue; }
    for (const a of [...o.attributes]) if (!n.hasAttribute(a.name)) o.removeAttribute(a.name);
    for (const a of n.attributes) if (o.getAttribute(a.name) !== a.value) o.setAttribute(a.name, a.value);
    if (o.nodeName === 'TEXTAREA' || o.nodeName === 'INPUT') {
      if (o !== document.activeElement && o.value !== n.value) o.value = n.value; // 入力中の欄の中身は、触らない
      continue;
    }
    syncChildren(o, n);
  }
  while (parent.childNodes.length > want.length) parent.removeChild(parent.lastChild);
}

// 題材の欄は、長くても全部見えるよう、文字の量に合わせて高さを変える
function fitTheme() {
  const el = document.getElementById('themeInput');
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight + 4}px`;
}

const chips = (list, mark) => `<div class="chips">${list.map((p) =>
  `<span class="chip ${p.connected ? '' : 'away'}${p.id === view?.me.id ? ' me' : ''}">${p.isHost ? badgeHost : ''}${esc(p.name)}${mark && mark(p) ? '<span class="mark">✓</span>' : ''}${p.connected ? '' : '<span class="tag">離席中</span>'}</span>`).join('')}</div>`;

const ICON_REDRAW = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.4-5.7"/><path d="M20 4v5h-5"/></svg>';
// 回答の長さで文字の大きさを変える（短い答えは大きく、長い答えは小さく）
const ICON_TRASH = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 13h10l1-13"/><path d="M10 11v6M14 11v6"/></svg>';
const SVG_ATTR = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';
const ICON_FLAG = `<svg ${SVG_ATTR}><path d="M5 21V4"/><path d="M5 4h12l-2.5 4L17 12H5"/></svg>`;
const ICON_GHOST = `<svg ${SVG_ATTR}><path d="M5 21V11a7 7 0 0 1 14 0v10l-2.5-2-2.3 2-2.2-2-2.2 2-2.3-2z"/><path d="M9.5 11v.01M14.5 11v.01"/></svg>`;
const badgeHost = '<span class="badge" role="img" aria-label="主催者">' + ICON_FLAG + '</span>';
const badgeSpec = '<span class="badge spec" role="img" aria-label="観戦中">' + ICON_GHOST + '</span>';
const ICON_HAMMER = `<svg ${SVG_ATTR}><path d="m15 12-8.373 8.373a1 1 0 1 1-3-3L12 9"/><path d="m18 15 4-4"/><path d="m21.5 11.5-1.914-1.914A2 2 0 0 1 19 8.172V7l-2.26-2.26a6 6 0 0 0-4.202-1.756L9 2.96l.92.82A6.18 6.18 0 0 1 12 8.4V10l2 2h1.172a2 2 0 0 1 1.414.586L18.5 14.5"/></svg>`;
const ICON_DOOR = `<svg ${SVG_ATTR}><path d="M13 4h3a2 2 0 0 1 2 2v14"/><path d="M2 20h3"/><path d="M13 20h9"/><path d="M10 12v.01"/><path d="M13 4.562v16.157a1 1 0 0 1-1.242.97L5 20V5.562a2 2 0 0 1 1.515-1.94l4-1A2 2 0 0 1 13 4.561Z"/></svg>`;
const ICON_SEND = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 3 10.5 13.5"/><path d="M21 3l-6.5 18-4-7.5L3 9.5z"/></svg>';
const sizeOf = (text) => { const n = [...String(text)].length; return n <= 8 ? 'lg' : n <= 22 ? 'md' : 'sm'; };

// 参加者の進み具合（回答済み・投票済み）。枠は付けず、見出しの横に数だけ出す
const progress = (label, list, done, side = '') => `<div class="progress"><h2><span>${label} ${list.filter(done).length}/${list.length}</span>${side}</h2>${chips(list, done)}</div>`;
// 回答待ちの時間：サーバーから届いた秒に、受け取ってからの時間を足して進める。制限時間があれば、残りを数える。
const clock = (sec) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
const elapsedNow = () => (view?.answerSec ?? 0) + Math.floor((performance.now() - viewAt) / 1000);
const timerInfo = () => {
  const limit = view?.settings.timeLimit ?? 0;
  if (!limit) return { text: clock(elapsedNow()), low: false, limit: 0 };
  const left = Math.max(0, limit - elapsedNow());
  return { text: clock(left), low: left <= 10, limit };
};
const timerHtml = () => {
  const t = timerInfo();
  return `<span class="timer${t.limit ? ' limited' : ''}${t.low ? ' low' : ''}" id="timer"><i class="ticon" aria-hidden="true">${t.limit ? (t.low ? '💣' : '⏳') : '⏱'}</i><b id="timerText">${t.text}</b></span>`;
};
setInterval(() => {
  const el = document.getElementById('timer');
  if (!el || view?.phase !== 'answer') return;
  const t = timerInfo();
  const tx = document.getElementById('timerText');
  if (tx && tx.textContent !== t.text) tx.textContent = t.text;
  el.classList.toggle('low', t.low);
  const ic = el.querySelector('.ticon');
  if (ic && t.limit) ic.textContent = t.low ? '💣' : '⏳';
}, 250);

const telop = (t) => t
  ? `<div class="telop"><div class="tile" id="tpTile">${esc(t.hiragana || '？')}</div><div class="telop-text"><span class="tiny">で始まる</span><strong id="tpTheme">${esc(t.theme)}</strong><span class="tiny">といえば？</span></div></div>`
  : '';

// 回答の制限時間：5〜180秒のバー。いちばん右が「なし」。目盛りをタップすると、その時間になる。
const TS_MIN = 5, TS_MAX = 180, TS_NONE = TS_MAX + 25; // 右端の「なし」は、180秒の目盛りと重ならないよう、少し離しておく
const TS_TICKS = [5, 30, 60, 90, 120, 150, 180, 0];
const tsPos = (v) => (Number(v) === 0 ? TS_NONE : Number(v));
const tsLabel = (v) => (Number(v) === 0 ? 'なし' : `${v}秒`);
function timeSliderHtml(value, ctx, disabled = false) {
  const frac = (pos) => (pos - TS_MIN) / (TS_NONE - TS_MIN);
  const ticks = TS_TICKS.map((v) => `<button type="button" class="tick${Number(value) === v ? ' on' : ''}" style="--f:${frac(tsPos(v))}" data-do="setTime" data-ctx="${ctx}" data-val="${v}" ${disabled ? 'disabled' : ''}>${v === 0 ? 'なし' : v}</button>`).join('');
  return `<div class="tslider" data-ctx="${ctx}">
    <div class="thead"><h2>回答の制限時間</h2><span class="tval">${tsLabel(value)}</span></div>
    <input type="range" class="trange" min="${TS_MIN}" max="${TS_NONE}" step="5" value="${tsPos(value)}" data-slider="${ctx}" style="--f:${frac(tsPos(value))}" aria-label="回答の制限時間" ${disabled ? 'disabled' : ''}>
    <div class="ticks">${ticks}</div>
  </div>`;
}

function entryHtml() {
  if (endMessage) return endHtml();
  const resume = session ? `<button class="link center" data-do="resume">前の部屋（${esc(session.code)}）に戻る</button>` : '';
  const body = ui.joining
    ? '<p class="hint center-text">部屋に入っています…</p>'
    : `<div class="entry-btns">
        <button class="bigbtn primary" data-do="openCreate">${ICON_HAMMER}<span>部屋をつくる</span></button>
        <button class="bigbtn" data-do="openJoin">${ICON_DOOR}<span>部屋に入る</span></button>
      </div>
      ${resume}`;
  const seg = (key, opts) => `<div class="seg">${opts.map(([val, label]) => `<button class="btn small ${newRoom[key] === val ? 'on' : ''}" data-do="newSet" data-key="${key}" data-val="${val}">${label}</button>`).join('')}</div>`;
  const createDialog = ui.createOpen && !ui.joining ? `<div class="scrim dialog" data-do="noop"><div class="sheet"><button class="x" data-do="closeCreate" aria-label="閉じる">×</button>
      <h3>部屋をつくる</h3>
      <div class="stack">
        <h2>出題者</h2>${seg('presenterMode', [['host', '主催者'], ['rotation', '順番']])}
        <h2>回答の見せ方</h2>${seg('identityMode', [['named', '記名'], ['anonymous', '匿名']])}
        <h2>正解を選ぶ人</h2>${seg('chooserMode', [['all', '全員'], ['one', '一人']])}
        ${timeSliderHtml(newRoom.timeLimit, 'create')}
      </div>
      <div class="dialog-actions"><button class="btn primary go" data-do="create">作成</button></div>
    </div></div>` : '';
  const dialog = ui.joinOpen && !ui.joining ? `<div class="scrim dialog" data-do="noop"><div class="sheet"><button class="x" data-do="closeJoin" aria-label="閉じる">×</button>
      <label class="field"><span>部屋コード</span><input id="codeInput" type="text" data-draft="code" maxlength="4" autocapitalize="characters" autocorrect="off" autocomplete="off" spellcheck="false" value="${esc(drafts.code)}"></label>
      <div class="seg join-seg">${[[false, '参戦'], [true, '観戦']].map(([val, label]) => `<button class="btn small ${ui.joinWatch === val ? 'on' : ''}" data-do="setJoinWatch" data-val="${val}">${label}</button>`).join('')}</div>
      <button class="btn primary block" style="margin-top:16px" data-do="join">入る</button>
    </div></div>` : '';
  return `<div class="entry">
    <div class="entry-top">
      <div class="telop hero"><div class="tile">あ</div><h1 class="hero-title">朝からそれ正解</h1></div>
    </div>
    ${body}
    ${ui.connected ? '' : '<p class="hint center-text">サーバーにつなぎ直しています。</p>'}
    <p class="foot-hint">※ シークレットモードなどでの使用は推奨しません</p>
    ${dialog}${createDialog}${toastHtml()}
  </div>`;
}

function endHtml() {
  const e = endMessage;
  return `<div class="end">
    <h1 class="title" style="font-size:28px">${esc(e.title)}</h1>
    ${e.body ? `<p class="hint">${esc(e.body)}</p>` : ''}
    ${e.retry && session ? '<button class="btn primary center" data-do="resume">もう一度入る</button>' : ''}
    <button class="btn center" data-do="backToEntry">入室画面に戻る</button>
    ${toastHtml()}
  </div>`;
}

function roomHtml() {
  const v = view;
  return `
    <header class="bar${isEditing() ? ' locked' : ''}">
      <button class="room" data-do="copyCode" aria-label="部屋番号${esc(v.code)}をコピー"><b class="code">${esc(v.code)}</b></button>
      <div class="round">${v.round ? `第${v.round}問` : ''}</div>
      <div class="bar-right">
        ${v.history.length ? '<button class="icon" data-do="sheet" data-kind="history" aria-label="記録"><svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="4" height="14" rx="1"/><rect x="9" y="4" width="4" height="14" rx="1"/><path d="M15.2 5.6l3.6-.9 2.7 12.7-3.6.9z"/><path d="M2 21h20"/></svg></button>' : ''}
        <button class="icon" data-do="openMenu" aria-label="メニュー"><svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 10.5a8.5 6 0 0 1 17 0z"/><path d="M2.5 14h19"/><path d="M4.5 17.5h15v.5a2.5 2.5 0 0 1-2.5 2.5h-10a2.5 2.5 0 0 1-2.5-2.5z"/></svg></button>
      </div>
    </header>
    ${ui.connected ? '' : '<p class="conn">再接続しています。</p>'}
    ${v.phase === 'vote' ? `<div class="phaseband">${v.settings.chooserMode === 'one' ? '選択中' : '投票中'}</div>` : ''}
    <main class="main">${phaseHtml()}</main>
    ${actionBar()}
    ${sheetHtml()}${modalHtml()}${toastHtml()}`;
}

function phaseHtml() {
  switch (view.phase) {
    case 'lobby': return lobbyHtml();
    case 'topic': return topicHtml();
    case 'answer': return answerHtml();
    case 'reveal': return revealHtml();
    case 'vote': return voteHtml();
    case 'result': return resultHtml();
    default: return '';
  }
}

function lobbyHtml() {
  const v = view;
  return `
    <div class="listhead"><h2>参加者 ${v.players.length}人</h2></div>
    ${rosterHtml()}
    <button class="btn small center" data-do="share">招待リンクを共有する</button>
`;
}

// ロビーの参加者：床がトランポリンのように、それぞれが跳ね続ける。
// 互いにはぶつからない。左右の壁では普通に跳ね返る。天井はないが、跳ねる高さの上限は枠の中に収まる。
// 跳ね具合は名前の長さしだい（文字が少ないほど高く跳ねる）。
const GRAVITY = 1500; // px/s²
const sprites = new Map(); // playerId -> {x,y,vx,vy,w,h,sq}
const bullets = []; // 横から時々飛んでくる弾 {id,x,y,dir,ox}
let bulletId = 0, nextShot = 1.5, lastTapAt = -1e9;
const bulletTf = (b) => `translate(${b.x}px,${b.y}px) rotate(${b.dir > 0 ? 90 : -90}deg)`; // 「A」のてっぺんが、飛んでいく向き
// 弾を1発打つ（発射数の制限はなし）
function fireBullet(f, dir, y) {
  const W = f.clientWidth;
  const b = { id: ++bulletId, dir, x: dir > 0 ? 0 : W, y, ox: dir > 0 ? 0 : W, hit: false };
  bullets.push(b);
  f.insertAdjacentHTML('beforeend', `<i class="bullet" data-b="${b.id}" style="transform:${bulletTf(b)}">A</i>`);
}
// タップすると、近い方の壁から、同じ高さに弾が飛ぶ（ひとり何発でも）
document.addEventListener('pointerdown', (e) => {
  const f = e.target.closest?.('#rosterField');
  if (!f) return;
  const r = f.getBoundingClientRect();
  const x = e.clientX - r.left, y = e.clientY - r.top;
  lastTapAt = performance.now();
  fireBullet(f, x < r.width / 2 ? 1 : -1, y);
});
const BULLET_SPEED = 520; // px/s
// 弾が当たったときの横速度：発射地点に近いほど猛烈に速く、遠いほどゆっくり（向きは弾の進行方向）
const hitSpeed = (dist01) => 15 + 985 * Math.pow(1 - dist01, 2.2);
const bounceRatio = (name) => 1 - (Math.min(20, Math.max(1, [...name].length)) - 1) / 19 * 0.65; // 1文字=100%、20文字=35%
function spriteOf(p) {
  let s = sprites.get(p.id);
  if (!s) {
    const sgn = Math.random() < 0.5 ? -1 : 1;
    s = { x: 16 + Math.random() * 200, y: 200 - Math.random() * 120, vx: sgn * (28 + Math.random() * 40), vy: 0, w: 0, h: 0, sq: 0 };
    sprites.set(p.id, s);
  }
  return s;
}
const spriteTf = (s) => `translate(${s.x}px,${s.y}px) scale(${1 + 0.18 * s.sq},${1 - 0.28 * s.sq})`;
function rosterHtml() {
  const players = view.players;
  for (const id of [...sprites.keys()]) if (!players.some((p) => p.id === id)) sprites.delete(id);
  const items = players.map((p) => {
    const s = spriteOf(p);
    return `<div class="sprite c${p.id === view.me.id ? 1 : 0}${p.connected ? '' : ' away'}${p.spectator ? ' spec' : ''}" data-pid="${esc(p.id)}" data-name="${esc(p.name)}" style="transform:${spriteTf(s)}">${p.isHost ? badgeHost : ''}${p.spectator ? badgeSpec : ''}${esc(p.name)}</div>`;
  }).join('');
  const shots = bullets.map((b) => `<i class="bullet" data-b="${b.id}" style="transform:${bulletTf(b)}">A</i>`).join('');
  return `<div class="bfield roster" id="rosterField">${items}${shots}</div>`;
}
let rosterAt = 0;
function rosterLoop(t) {
  requestAnimationFrame(rosterLoop);
  const dt = Math.min(0.05, (t - (rosterAt || t)) / 1000);
  rosterAt = t;
  const f = document.getElementById('rosterField');
  if (!f || reduceMotion) return;
  const W = f.clientWidth, H = f.clientHeight;
  // 弾：ときどき（少なめに）、左右どちらかの端から横に飛んでくる
  // 自動の弾：だれかがタップして10秒たつまでは、お休み（10秒なにもなければ、また飛ぶ）
  if (performance.now() - lastTapAt > 10000) nextShot -= dt;
  if (nextShot <= 0) {
    nextShot = 2.5 + Math.random() * 3.5; // 30秒に7発ほど
    fireBullet(f, Math.random() < 0.5 ? 1 : -1, 10 + Math.random() * Math.max(1, H - 20));
  }
  for (const b of bullets) {
    b.x += b.dir * BULLET_SPEED * dt;
    for (const el of f.querySelectorAll('.sprite')) {
      const s = sprites.get(el.dataset.pid);
      if (!s || b.hit) continue;
      if (b.x >= s.x && b.x <= s.x + s.w && b.y >= s.y && b.y <= s.y + s.h) {
        const d = Math.min(1, Math.abs(b.x - b.ox) / Math.max(1, W));
        s.vx = b.dir * hitSpeed(d); // 向きも速さも、弾しだい
        s.sq = Math.max(s.sq, 0.7);
        b.hit = true;
      }
    }
  }
  for (let i = bullets.length - 1; i >= 0; i--) {
    const b = bullets[i];
    const gone = b.hit || b.x < -10 || b.x > W + 10;
    const el = f.querySelector(`.bullet[data-b="${b.id}"]`);
    if (gone) { el?.remove(); bullets.splice(i, 1); } else if (el) el.style.transform = bulletTf(b);
  }
  for (const el of f.querySelectorAll('.sprite')) {
    const s = sprites.get(el.dataset.pid);
    if (!s) continue;
    s.w = el.offsetWidth; s.h = el.offsetHeight;
    const m = s.w * 0.09; // 着地でぐにゃっと広がる分の余白
    const floorY = Math.max(0, H - s.h), minX = m, maxX = Math.max(minX, W - s.w - m);
    const apex = Math.max(20, (floorY - 6) * bounceRatio(el.dataset.name)); // 跳ねる高さ（枠の高さを超えない）
    const launch = Math.sqrt(2 * GRAVITY * apex);
    s.vy += GRAVITY * dt;
    s.y += s.vy * dt;
    // 横方向：速さは次の弾が当たるまで変わらない（壁で跳ね返っても、そのまま）
    s.x += s.vx * dt;
    if (s.x < minX) { s.x = minX; s.vx = Math.abs(s.vx); } else if (s.x > maxX) { s.x = maxX; s.vx = -Math.abs(s.vx); }
    if (s.y >= floorY) { s.y = floorY; s.vy = -launch; s.sq = 1; } // トランポリン：着地のたびに、同じ高さまで跳ね返す
    const top = floorY - apex - 1;
    if (s.y < top) { s.y = top; if (s.vy < 0) s.vy = 0; } // 計算の誤差で上限を超えない
    s.sq = Math.max(0, s.sq - dt * 7); // 着地の一瞬だけ、ぐにゃっと縮む
    el.style.transform = spriteTf(s);
  }
}
requestAnimationFrame(rosterLoop);

// お題を待つあいだの、跳ね返り続けるロゴ（DVDプレイヤーの待ち受けのような）。位置は画面を作り直しても引き継ぐ。
const bounce = { x: 24, y: 18, vx: 72, vy: 54, c: 0 };
const bounceHtml = () => `<div class="bfield" id="bounceField"><div class="blogo c${bounce.c}" id="bounceLogo" style="transform:translate(${bounce.x}px,${bounce.y}px)"><span class="bt">あ</span><span class="bl"><i></i><i></i></span></div></div>`;
const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
let bounceAt = 0;
function bounceLoop(t) {
  requestAnimationFrame(bounceLoop);
  const dt = Math.min(0.05, (t - (bounceAt || t)) / 1000);
  bounceAt = t;
  const f = document.getElementById('bounceField'), l = document.getElementById('bounceLogo');
  if (!f || !l || reduceMotion) return;
  const maxX = Math.max(0, f.clientWidth - l.offsetWidth), maxY = Math.max(0, f.clientHeight - l.offsetHeight);
  bounce.x += bounce.vx * dt;
  bounce.y += bounce.vy * dt;
  let hit = false;
  if (bounce.x < 0) { bounce.x = 0; bounce.vx = Math.abs(bounce.vx); hit = true; } else if (bounce.x > maxX) { bounce.x = maxX; bounce.vx = -Math.abs(bounce.vx); hit = true; }
  if (bounce.y < 0) { bounce.y = 0; bounce.vy = Math.abs(bounce.vy); hit = true; } else if (bounce.y > maxY) { bounce.y = maxY; bounce.vy = -Math.abs(bounce.vy); hit = true; }
  if (hit) { bounce.c = (bounce.c + 1) % 4; l.className = `blogo c${bounce.c}`; } // 壁に当たるたび、色が変わる
  l.style.transform = `translate(${bounce.x}px,${bounce.y}px)`;
}
requestAnimationFrame(bounceLoop);

function topicHtml() {
  const v = view;
  if (!v.me.isPresenter) {
    return bounceHtml();
  }
  // テロップそのものが入力欄（頭文字と題材を、直接書き換える）
  const rbtn = (part, label, cls = '') => `<button class="rbtn ${cls}" data-do="draw" data-part="${part}" aria-label="${label}を引き直す">${ICON_REDRAW}<small>${label}</small></button>`;
  return `
    <div class="telop edit">
      <div class="tile"><input id="hiraInput" class="tile-input" type="text" data-draft="hiragana" maxlength="1" placeholder="？" aria-label="頭文字" autocomplete="off" value="${esc(drafts.hiragana)}"></div>
      <div class="telop-text"><span class="tiny">で始まる</span><textarea id="themeInput" class="theme-edit" rows="1" data-draft="theme" maxlength="40" placeholder="題材" aria-label="題材">${esc(drafts.theme)}</textarea><span class="tiny">といえば？</span></div>
    </div>
    <div class="redraw-row">
      <div class="redraws">
        <div class="rgroup">${rbtn('hiragana', '頭文字')}${rbtn('theme', '題材')}</div>
        ${rbtn('both', '両方')}
      </div>
      <button class="rbtn trash" data-do="reportTopic" aria-label="この題材を報告して引き直す">${ICON_TRASH}<small>報告</small></button>
    </div>
`;
}

function answerHtml() {
  const v = view;
  const box = v.me.spectator ? '' : `
    <div class="answerbox">
      <textarea id="answerInput" data-draft="answer" rows="3" maxlength="100" placeholder="答えを入力" ${v.myAnswer !== null ? 'readonly' : ''}>${esc(drafts.answer)}</textarea>
      <div class="box-actions">${v.myAnswer !== null ? '<button class="btn small" data-do="withdraw">取り下げる</button>' : '<button class="btn primary small" data-do="submitAnswer">回答する</button>'}</div>
    </div>`;
  return `
    ${telop(v.topic)}${box}
    ${progress('回答状況', v.players.filter((p) => !p.spectator), (p) => p.answered, timerHtml())}`;
}

// 回答のプール：全部の回答が、位置を変えずに並ぶ。未開示は黒マス、開示されたものだけ中身が見える。
// 主催者が「同じ回答」としてまとめたものには、同じ記号（A、B…）の札が付く。チェックは、まとめる／ばらす対象の選択。
const groupMark = (n) => String.fromCharCode(64 + n);
function poolHtml() {
  const v = view, anon = v.settings.identityMode === 'anonymous';
  const editing = isEditing();
  const myGroup = v.myVote ? v.pool.find((x) => x.answerId === v.myVote)?.group ?? null : null;
  const cells = v.pool.map((c) => {
    const me = c.mine ? ' mine' : '';
    if (!c.revealed) {
      const cls = `cell dark${me}`;
      const inner = c.canReveal && !editing
        ? `<button class="${cls} tap" aria-label="開示" data-do="${anon ? 'revealSelected' : 'revealOwn'}" data-id="${esc(c.answerId)}"></button>`
        : `<div class="${cls}"></div>`;
      return `<div class="cw">${inner}</div>`;
    }
    const wide = [...c.text].length > 10 ? ' wide' : '';
    const picked = v.myVote === c.answerId || (myGroup !== null && c.group === myGroup);
    const body = `<span class="txt"><span class="text ${sizeOf(c.text)}">${esc(c.text)}</span>${c.author ? `<span class="by">${esc(c.author)}</span>` : ''}</span>`;
    const cls = `cell open${me}${picked ? ' picked' : ''}`;
    const main = c.canVote && !editing
      ? `<button class="${cls}" data-do="vote" data-id="${esc(c.answerId)}">${body}</button>`
      : `<div class="${cls}">${body}</div>`;
    const on = ui.sel.has(c.answerId);
    const check = c.canGroup && editing ? `<button class="chk${on ? ' on' : ''}" role="checkbox" aria-checked="${on}" aria-label="まとめる対象に選ぶ" data-do="toggleSel" data-id="${esc(c.answerId)}"></button>` : '';
    const tag = c.group ? `<span class="gtag" aria-label="同じ回答 ${groupMark(c.group)}">${groupMark(c.group)}</span>` : '';
    return `<div class="cw${wide}${editing ? ' sel' : ''}">${main}${check}${tag}</div>`;
  }).join('');
  return `<section class="pool">${cells}</section>`;
}

// 主催者だけの、同じ回答をまとめる操作。見出しの右の同じボタンで、編集のオン／オフを切り替える。編集中は、ほかの操作はできない。
function groupToggleHtml() {
  if (!canEditGroups()) return '';
  const on = isEditing();
  return `<button class="btn small edit-toggle${on ? ' on' : ''}" data-do="${on ? 'editDone' : 'editOn'}">${on ? '編集を完了' : 'まとめを編集'}</button>`;
}

// 編集中だけ、プールの下に出る「まとめる」「ばらす」
function groupBarHtml() {
  const v = view;
  if (!isEditing()) return '';
  const picked = v.pool.filter((c) => ui.sel.has(c.answerId));
  const canGroup = picked.length >= 2;
  const canUngroup = picked.some((c) => c.group);
  return `<div class="groupbar"><span class="gcount">${picked.length ? `${picked.length}件を選択中` : ''}</span>
    <button class="btn small" data-do="groupSel" ${canGroup ? '' : 'disabled'}>まとめる</button>
    <button class="btn small" data-do="ungroupSel" ${canUngroup ? '' : 'disabled'}>ばらす</button></div>`;
}

function revealHtml() {
  const v = view, host = v.me.isHost;
  const total = v.pool.length;
  return `
    ${telop(v.topic)}
    <div class="listhead"><h2>開示済み ${total - v.unrevealedCount}/${total}</h2><span class="lh-actions">${host && v.unrevealedCount > 0 && !isEditing() ? '<button class="btn small" data-do="revealAll">残りを全員分開示</button>' : ''}${groupToggleHtml()}</span></div>
    ${poolHtml()}${groupBarHtml()}
    ${reactBarHtml()}
`;
}

function voteHtml() {
  const v = view, one = v.settings.chooserMode === 'one';
  return `
    ${telop(v.topic)}
    <div class="listhead"><h2>${one ? (v.me.isChooser ? '正解を選んでください' : '正解を選んでいます') : '正解だと思う回答に投票'}</h2>${groupToggleHtml()}</div>
    ${poolHtml()}${groupBarHtml()}
    ${one ? '' : progress('投票状況', v.players.filter((p) => !p.spectator), (p) => p.voted)}`;
}

function resultHtml() {
  const v = view, r = v.result;
  if (!r) return '<p class="hint">結果を集計しています。</p>';
  const winners = new Set(r.winners);
  const rows = [...r.tallies].sort((a, b) => b.votes - a.votes).map((t) => {
    const won = winners.has(t.answerId);
    const wide = won || [...t.text].length > 10 ? ' wide' : '';
    return `<div class="cell ${won ? 'win' : 'open'}${wide}">
      ${t.group ? `<span class="gtag in" aria-label="同じ回答 ${groupMark(t.group)}">${groupMark(t.group)}</span>` : ''}
      ${won ? '<span class="stamp">正解</span>' : ''}
      <span class="txt"><span class="text ${won ? 'lg' : sizeOf(t.text)}">${esc(t.text)}</span><span class="by">${esc(t.author)}</span></span>${r.mode === 'one' ? '' : `<span class="vcount">${t.votes}<small>票</small></span>`}</div>`;
  }).join('');
  return `
    ${telop(v.topic)}
    ${r.tie ? '<p class="hint">同票：どれも正解</p>' : ''}
    ${r.noAnswer || r.winners.length === 0 ? `<div class="allwrong"><b>全員不正解！</b><span>${r.noAnswer ? '回答がありませんでした' : '投票がありませんでした'}</span></div>` : ''}
    ${rows ? `<section class="pool">${rows}</section>` : ''}`;
}

function actionBar() {
  const v = view, host = v.me.isHost;
  const lock = isEditing(); // まとめの編集中は、先へ進めない（ボタンを押せなくして、理由を添える）
  let btn = '', meta = '';
  switch (v.phase) {
    case 'lobby':
      if (host) {
        const n = v.players.filter((p) => p.connected && !p.spectator).length;
        btn = `<button class="btn primary block" data-do="advance" ${n < 3 ? 'disabled' : ''}>はじめる</button>`;
        meta = n < 3 ? '3人以上で始められます' : '';
      }
      break;
    case 'topic':
      if (v.me.isPresenter) btn = '<button class="btn primary block" data-do="confirmTopic">この題で決定</button>';
      break;
    case 'answer':
      if (host) { btn = '<button class="btn primary block" data-do="advance">開示へ進む</button>' }
      break;
    case 'reveal':
      if (host) {
        const left = v.unrevealedCount;
        btn = `<button class="btn primary block" data-do="advance" ${left > 0 || lock ? 'disabled' : ''}>投票へ進む</button>`;
        if (lock) meta = 'まとめの編集中は進めません';
      }
      break;
    case 'vote':
      if (v.settings.chooserMode === 'one' ? v.me.isChooser : host) {
        btn = `<button class="btn primary block" data-do="advance" ${(v.pendingCount > 0 && v.settings.chooserMode === 'one') || lock ? 'disabled' : ''}>結果を見る</button>`;
        if (lock) meta = 'まとめの編集中は進めません';
      }
      break;
    case 'result':
      if (host) btn = '<button class="btn primary block" data-do="advance">次のラウンドへ</button>';
      break;
  }
  // 題決めの間は、出題者を丸いチップで出す。出題者本人と主催者は、タップして変更できる。
  let who = '';
  if (v.phase === 'topic') {
    const name = v.players.find((p) => p.id === v.presenterId)?.name ?? '';
    const can = v.me.canAssignPresenter;
    const inner = `<span class="av">${esc([...name][0] ?? '?')}</span><span class="who-text">出題者 <b>${esc(name)}</b></span>${can ? `<span class="who-edit">${ICON_SEND}変更</span>` : ''}`;
    who = can ? `<button class="who" data-do="sheet" data-kind="presenter">${inner}</button>` : `<div class="who">${inner}</div>`;
  }
  if (v.phase === 'vote' && v.settings.chooserMode === 'one') {
    const name = v.players.find((p) => p.id === v.chooserId)?.name ?? '';
    const can = v.me.canAssignChooser;
    const inner = `<span class="av">${esc([...name][0] ?? '?')}</span><span class="who-text">選ぶ人 <b>${esc(name)}</b></span>${can ? `<span class="who-edit">${ICON_SEND}変更</span>` : ''}`;
    who = can ? `<button class="who" data-do="sheet" data-kind="chooser">${inner}</button>` : `<div class="who">${inner}</div>`;
  }
  if (!who && v.me.spectator && !btn) who = `<button class="who" data-do="toggleSpectate"><span class="who-text">観戦中</span><span class="who-edit">参戦する</span></button>`;
  return btn || who ? `<div class="action"><div>${who}${meta ? `<p class="meta">${meta}</p>` : ''}${btn}</div></div>` : '';
}

// ---------- シート（メニューなど）と確認 ----------

function sheetHtml() {
  if (!ui.sheet) return '';
  const v = view, k = ui.sheet.kind, host = v.me.isHost;
  const others = v.players.filter((p) => p.id !== v.me.id);
  const pick = (kind, list) => list.map((p) => `<button class="btn" data-do="pick" data-kind="${kind}" data-id="${esc(p.id)}">${esc(p.name)}${p.spectator ? '（観戦中）' : ''}${p.connected === false ? '（離席中）' : ''}</button>`).join('') || '<p class="hint">対象の人がいません。</p>';
  let inner = '';
  if (k === 'menu') {
    const item = (cls, attrs, label, side = '') => `<button class="item ${cls}" ${attrs}><span>${label}</span>${side ? `<span class="side">${side}</span>` : ''}</button>`;
    inner = `<h3>メニュー</h3><div class="menu-list">
      <div class="group">
        ${item('', 'data-do="share"', '招待リンクを共有')}
        ${item('', 'data-do="openRename"', '表示名を変える', esc(v.me.name))}
        ${item('', 'data-do="sheet" data-kind="players"', '参加者一覧', `${v.players.length}人`)}
      </div>
      ${host ? `<div class="group"><p class="group-label">主催者</p>
        ${v.me.canReclaim ? item('', 'data-do="reclaim"', v.phase === 'vote' ? '選ぶ人を回収する' : '出題者を回収する') : ''}
        ${item('', 'data-do="sheet" data-kind="settings"', 'ルール設定')}
        ${item('', 'data-do="resetRoom"', '記録をリセット')}
        ${item('', 'data-do="sheet" data-kind="transfer"', '主催者を譲る')}
        ${v.removed.length ? item('', 'data-do="sheet" data-kind="allow"', '再入室を許可', `${v.removed.length}人`) : ''}
      </div>` : ''}
      ${`<div class="group">${item('', 'data-do="toggleSpectate"', (v.me.nextSpectator ?? v.me.spectator) ? '参戦に切り替える' : '観戦に切り替える', v.me.nextSpectator !== null && v.me.nextSpectator !== undefined ? '次のラウンドから' : '')}</div>`}
      <div class="group">
        ${item('danger', 'data-do="leave"', '退出する')}
        ${host ? item('danger', 'data-do="closeRoom"', '部屋を閉じる') : ''}
      </div>
    </div>`;
  } else if (k === 'history') {
    const tot = new Map();
    for (const h of v.history) for (const e of h.entries) { const t = tot.get(e.author) ?? { w: 0, v: 0 }; t.w += e.won ? 1 : 0; t.v += e.votes; tot.set(e.author, t); }
    const rank = [...tot].sort((x, y) => y[1].w - x[1].w || y[1].v - x[1].v);
    const maxW = Math.max(1, ...rank.map(([, t]) => t.w));
    const graph = `<div class="graph">${rank.map(([n, t]) => `<div class="g-row${t.w > 0 && t.w === maxW ? ' top' : ''}"><span class="g-name">${esc(n)}</span><span class="g-track"><i style="width:${Math.max(4, (t.w / maxW) * 100)}%"></i></span><span class="g-val">${t.w}<small>正解</small></span></div>`).join('')}</div>`;
    // 得票率：全員の投票で決めたラウンドについて、その人の回答が受けた票 ÷ 投じられた票の合計
    const rate = new Map();
    let rounds = 0;
    for (const h of v.history) {
      if (h.mode === 'one' || !h.total) continue;
      rounds += 1;
      for (const e of h.entries) { const t = rate.get(e.author) ?? { got: 0, all: 0 }; t.got += e.votes; t.all += h.total; rate.set(e.author, t); }
    }
    const rr = [...rate].map(([n, t]) => [n, t.all ? (t.got / t.all) * 100 : 0]).sort((x, y) => y[1] - x[1]);
    const maxR = Math.max(1, ...rr.map(([, p]) => p));
    const rateGraph = rounds ? `<h3 class="sub">得票率</h3><div class="graph rate">${rr.map(([n, p]) => `<div class="g-row${p > 0 && p === maxR ? ' top' : ''}"><span class="g-name">${esc(n)}</span><span class="g-track"><i style="width:${Math.max(4, (p / maxR) * 100)}%"></i></span><span class="g-val">${Math.round(p)}<small>%</small></span></div>`).join('')}</div>` : '';
    inner = `<h3>これまでの記録</h3>${graph}${rateGraph}<div class="history">${v.history.map((h) => `
      <article class="rec">
        <div class="rec-head"><span class="rec-no">第${h.round}問</span><span class="rec-topic"><b>${esc(h.topic.hiragana)}</b>で始まる ${esc(h.topic.theme)}</span></div>
        ${h.entries.map((e) => `<div class="rec-row ${e.won ? 'won' : ''}"><span class="rec-text">${esc(e.text)}<small>${esc(e.author)}</small></span><span class="rec-votes">${e.won ? '<i>正解</i>' : ''}${h.mode === 'one' ? '' : `${e.votes}票`}</span></div>`).join('')}
      </article>`).join('')}</div>`;
  } else if (k === 'rename') {
    inner = `<h3>表示名を変える</h3><div class="stack">
      <label class="field"><span>表示名</span><input id="renameInput" type="text" data-draft="rename" maxlength="20" autocomplete="off" value="${esc(drafts.rename)}"></label>
      <button class="btn primary block" data-do="doRename">変更する</button></div>`;
  } else if (k === 'settings') {
    const s = v.settings, locked = !['lobby', 'result'].includes(v.phase);
    const seg = (key, opts) => `<div class="seg">${opts.map(([val, label]) => `<button class="btn small ${String(s[key]) === String(val) ? 'on' : ''}" data-do="set" data-key="${key}" data-val="${val}" ${locked ? 'disabled' : ''}>${label}</button>`).join('')}</div>`;
    const ids = s.order.filter((id) => v.players.some((p) => p.id === id && !p.spectator));
    const order = s.presenterMode === 'rotation' ? `<h2>順番（上から）</h2><ul class="order">${ids.map((id, i) => `<li>${esc(v.players.find((p) => p.id === id).name)}<span>
      <button class="btn small" data-do="move" data-id="${esc(id)}" data-dir="-1" ${i === 0 || locked ? 'disabled' : ''} aria-label="上へ">↑</button>
      <button class="btn small" data-do="move" data-id="${esc(id)}" data-dir="1" ${i === ids.length - 1 || locked ? 'disabled' : ''} aria-label="下へ">↓</button></span></li>`).join('')}</ul>` : '';
    inner = `<h3>部屋設定</h3><div class="stack">
      ${locked ? '<p class="hint">ラウンド中は変更できません</p>' : ''}
      <h2>出題者</h2>${seg('presenterMode', [['host', '主催者'], ['rotation', '順番']])}
      <h2>回答の見せ方</h2>${seg('identityMode', [['named', '記名'], ['anonymous', '匿名']])}
      <h2>正解を選ぶ人</h2>${seg('chooserMode', [['all', '全員'], ['one', '一人']])}
      ${timeSliderHtml(s.timeLimit, 'settings', locked)}
      ${order}</div>`;
  } else if (k === 'transfer') {
    inner = `<h3>主催者を譲渡する</h3><div class="menu">${pick('transfer', others.filter((p) => p.connected))}</div>`;
  } else if (k === 'players') {
    // 全員が見られる。外せるのは主催者だけ（自分自身はタップしても何も起きない）
    const row = (p) => {
      const me = p.id === v.me.id;
      const inner = `${p.isHost ? badgeHost : ''}${p.spectator ? badgeSpec : ''}<span class="pname">${esc(p.name)}</span>${me ? '<span class="tag">あなた</span>' : ''}${p.connected === false ? '<span class="tag">離席中</span>' : ''}`;
      return host && !me
        ? `<button class="btn prow" data-do="pick" data-kind="remove" data-id="${esc(p.id)}">${inner}</button>`
        : `<div class="prow${me ? ' me' : ''}">${inner}</div>`;
    };
    inner = `<h3>参加者一覧</h3><div class="plist">${v.players.map(row).join('')}</div>`;
  } else if (k === 'allow') {
    inner = `<h3>再入室を許可する</h3><div class="menu">${pick('allow', v.removed)}</div>`;
  } else if (k === 'chooser') {
    inner = `<h3>選ぶ人を任せる</h3><div class="menu"><button class="btn" data-do="randomChooser">ランダムで指名する</button>${pick('chooser', v.players.filter((p) => p.connected && p.id !== v.chooserId))}</div>`;
  } else if (k === 'presenter') {
    inner = `<h3>出題者を指名する</h3><div class="menu">
      <button class="btn" data-do="randomPresenter">ランダムで指名する</button>
      ${pick('presenter', v.players.filter((p) => p.connected && p.id !== v.presenterId))}</div>`;
  }
  return `<div class="scrim" data-do="scrim"><div class="sheet"><button class="x" data-do="closeSheet" aria-label="閉じる">×</button>${inner}</div></div>`;
}

function modalHtml() {
  const m = ui.modal;
  if (!m) return '';
  return `<div class="scrim dialog" data-do="noop"><div class="sheet"><button class="x" data-do="modalCancel" aria-label="閉じる">×</button>
    ${m.quote ? `<p class="vquote">${esc(m.quote)}</p>` : `<p>${esc(m.body)}</p>`}
    <div class="dialog-actions"><button class="btn ${m.danger ? 'danger' : 'primary'} go" data-do="modalOk">${esc(m.ok)}</button></div>
  </div></div>`;
}

const toastHtml = () => (ui.toast ? `<div class="toast" role="status">${esc(ui.toast)}</div>` : '');

// ---------- 操作 ----------

function confirmPick(kind, id) {
  const name = view.players.find((p) => p.id === id)?.name ?? view.removed.find((p) => p.id === id)?.name ?? '';
  const spec = {
    transfer: { body: `${name}さんに主催者を譲渡します。あなたは一般参加者になります。`, ok: '譲渡する', go: () => act('transferHost', { to: id }) },
    remove: { body: `${name}さんを部屋から外します。許可するまで、入り直せなくなります。`, ok: '外す', danger: true, go: () => act('removePlayer', { to: id }) },
    allow: { body: `${name}さんの再入室を許可します。`, ok: '許可する', go: () => act('allowRejoin', { to: id }) },
    chooser: { body: `${name}さんに、正解を選ぶ人を任せます。`, ok: '任せる', go: () => act('setChooser', { to: id }) },
    presenter: { body: `${name}さんに出題者を任せます。`, ok: '任せる', go: () => act('setPresenter', { to: id }) },
  }[kind];
  ui.sheet = null;
  ui.modal = { body: spec.body, ok: spec.ok, danger: spec.danger, onOk: spec.go };
  render();
}

const handlers = {
  openCreate() { ui.createOpen = true; render(); },
  closeCreate() { ui.createOpen = false; render(); },
  setTime(d) {
    const val = Number(d.val);
    if (d.ctx === 'create') { newRoom.timeLimit = val; render(); }
    else act('setSettings', { patch: { timeLimit: val } });
  },
  newSet(d) { newRoom[d.key] = d.val; render(); },
  create() {
    if (!sendCritical({ t: 'create', name: prefName, clientId, settings: { ...newRoom } })) return; // つながっていないときは、ポップアップを閉じずに知らせる
    autoJoin = true;
    ui.createOpen = false;
    ui.joining = true; // 押した直後に、反応を見せる
    render();
  },
  openJoin() {
    ui.joinOpen = true;
    render();
    document.getElementById('codeInput')?.focus(); // タップの流れの中でフォーカスすると、iPhoneでもキーボードが出る
  },
  closeJoin() { ui.joinOpen = false; render(); },
  join() {
    const code = drafts.code.trim().toUpperCase();
    if (code.length < 4) return toast('部屋コードを4文字で入力してください');
    autoJoin = true;
    if (sendJoin(code, ui.joinWatch)) { ui.joining = true; render(); }
  },
  setJoinWatch(d) { ui.joinWatch = d.val === 'true'; render(); },
  resume() {
    autoJoin = true; endMessage = null;
    sendJoin(session.code);
  },
  openRename() {
    drafts.rename = view.me.name;
    ui.sheet = { kind: 'rename' };
    render();
    document.getElementById('renameInput')?.focus();
  },
  doRename() {
    const name = drafts.rename.trim();
    if (!name) return toast('表示名を入力してください');
    if (name === view.me.name) { // 変わっていなくても、この名前を次の部屋以降の既定にする
      prefName = name; saveName(name); ui.sheet = null; render(); return;
    }
    ui.pendingRename = name;
    act('rename', { name });
  },
  backToEntry() { endMessage = null; render(); },
  openMenu() { ui.sheet = { kind: 'menu' }; render(); },
  closeSheet() { ui.sheet = null; render(); },
  scrim(_d, el, e) { if (e.target === el) { ui.sheet = null; render(); } },
  noop() {},
  sheet(d) { ui.sheet = { kind: d.kind }; render(); },
  set(d) { act('setSettings', { patch: { [d.key]: d.val } }); },
  move(d) {
    const ids = view.settings.order.filter((id) => view.players.some((p) => p.id === id));
    const i = ids.indexOf(d.id), j = i + Number(d.dir);
    if (i < 0 || j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    act('setSettings', { patch: { order: ids } });
  },
  pick(d) { confirmPick(d.kind, d.id); },
  randomPresenter() { ui.sheet = null; act('randomPresenter'); render(); },
  reclaim() {
    ui.sheet = null;
    const who = view.phase === 'vote' ? '正解を選ぶ人' : '出題者';
    ui.modal = { body: `${who}の役割を、主催者に戻します。`, ok: '回収する', onOk: () => act('reclaimRole') };
    render();
  },
  randomChooser() { ui.sheet = null; act('randomChooser'); render(); },
  // 観戦⇔参戦。回答中までは、すぐ。それ以降は次のラウンドから。
  toggleSpectate() {
    ui.sheet = null;
    const want = !(view.me.nextSpectator ?? view.me.spectator);
    if (!act('setSpectator', { spectator: want })) return;
    if (!['lobby', 'topic', 'answer', 'result'].includes(view.phase) && want !== view.me.spectator) toast(`次のラウンドから${want ? '観戦' : '参戦'}になります`);
    render();
  },
  resetRoom() {
    ui.sheet = null;
    ui.modal = { body: '記録と問題数を消して、最初の画面に戻します。参加者と設定は、そのまま残ります。', ok: 'リセットする', danger: true, onOk: () => act('resetRoom') };
    render();
  },
  reportTopic() {
    const t = view.topic?.theme;
    if (!t || drafts.theme.trim() !== t) return toast('書き換えた題材は報告できません');
    ui.modal = {
      body: `「${t}」を報告して、引き直します。この部屋では二度と出ません。`,
      ok: '報告する',
      danger: true,
      onOk: () => act('reportTopic', { theme: t }),
    };
    render();
  },
  draw(d) { act('drawTopic', { part: d.part, hiragana: drafts.hiragana, theme: drafts.theme }); },
  confirmTopic() { act('confirmTopic', { hiragana: drafts.hiragana, theme: drafts.theme }); },
  submitAnswer() {
    const text = drafts.answer.trim();
    if (!text) return toast('答えを入力してください');
    act('submitAnswer', { text });
  },
  withdraw() { act('withdrawAnswer'); }, // 入力した文章は残す（そのまま直して、もう一度回答できる）
  revealOwn() { act('revealOwn'); },
  revealSelected(d) { act('revealSelected', { answerId: d.id }); },
  revealAll() { act('revealAll'); },
  react(d) { act('react', { kind: d.kind }); },
  editOn() { ui.sheet = null; ui.sel.clear(); ui.editing = true; render(); },
  editDone() { ui.editing = false; ui.sel.clear(); render(); },
  toggleSel(d) { if (ui.sel.has(d.id)) ui.sel.delete(d.id); else ui.sel.add(d.id); render(); },
  groupSel() {
    const ids = view.pool.filter((c) => ui.sel.has(c.answerId)).map((c) => c.answerId);
    if (ids.length < 2) return;
    ui.sel.clear();
    act('group', { answerIds: ids });
  },
  ungroupSel() {
    const ids = view.pool.filter((c) => ui.sel.has(c.answerId) && c.group).map((c) => c.answerId);
    if (!ids.length) return;
    ui.sel.clear();
    act('ungroup', { answerIds: ids });
  },
  vote(d) {
    const mine = view.pool.find((x) => x.answerId === view.myVote);
    const tapped0 = view.pool.find((x) => x.answerId === d.id);
    if (mine && tapped0 && mine.group && mine.group === tapped0.group) return; // 同じまとまりへは、投票済み
    if (view.myVote === d.id) return;
    const c = view.pool.find((x) => x.answerId === d.id);
    if (!c) return;
    const one = view.settings.chooserMode === 'one';
    ui.modal = { quote: c.text, ok: one ? (view.myVote ? '正解を変更' : '正解にする') : (view.myVote ? '投票を変更' : '投票する'), onOk: () => act(one ? 'choose' : 'vote', { answerId: d.id }) };
    render();
  },
  advance() { act('advance'); },
  modalOk() { const m = ui.modal; ui.modal = null; render(); m?.onOk?.(); },
  modalCancel() { ui.modal = null; render(); },
  async copyCode() {
    const code = view.code;
    try {
      await navigator.clipboard.writeText(code);
    } catch { // 使えない環境では、選択してコピーする方法で試す
      const t = document.createElement('textarea');
      t.value = code; t.style.position = 'fixed'; t.style.opacity = '0';
      document.body.appendChild(t); t.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch { /* 失敗しても動く */ }
      t.remove();
      if (!ok) return toast(`部屋番号：${code}`);
    }
    toast(`部屋番号 ${code} をコピーしました`);
  },
  async share() {
    const url = `${location.origin}/?code=${view.code}`; // 開くだけで、この部屋にそのまま入れる
    ui.sheet = null;
    // リンクは文章の中に入れる（url を別に渡すと、「コピー」で落ちる端末がある）
    try {
      if (navigator.share) { await navigator.share({ title: '朝からそれ正解', text: `朝からそれ正解の部屋に入る（部屋コード ${view.code}）\n${url}` }); return; }
    } catch { return; } // 共有をやめた場合
    try { await navigator.clipboard.writeText(url); toast('招待リンクをコピーしました'); } catch { toast(url); }
  },
  leave() {
    ui.sheet = null;
    const others = view.players.filter((p) => p.id !== view.me.id && p.connected);
    if (view.me.isHost && others.length > 0) {
      ui.sheet = { kind: 'transfer' };
      toast('先に主催者を譲渡してください');
      return;
    }
    ui.modal = { body: 'この部屋から退出します。同じ端末なら、あとで戻れます。', ok: '退出する', danger: true, onOk: () => act('leave') };
    render();
  },
  closeRoom() {
    ui.sheet = null;
    ui.modal = { body: '部屋を閉じます。全員の画面が終了し、記録も破棄されます。', ok: '閉じる', danger: true, onOk: () => act('closeRoom') };
    render();
  },
};

$app.addEventListener('click', (e) => {
  const el = e.target.closest('[data-do]');
  if (!el || el.disabled) return;
  handlers[el.dataset.do]?.(el.dataset, el, e);
});

$app.addEventListener('input', (e) => {
  const key = e.target.dataset?.draft;
  if (!key) return;
  if (key === 'code') e.target.value = e.target.value.toUpperCase();
  if (key === 'theme' && /\n/.test(e.target.value)) e.target.value = e.target.value.replace(/\n/g, '');
  drafts[key] = e.target.value;
  if (key === 'theme') fitTheme();
  if (key === 'hiragana' || key === 'theme') { // お題のプレビューだけ、作り直さずに書き換える
    const tile = document.getElementById('tpTile'), theme = document.getElementById('tpTheme');
    if (tile) tile.textContent = drafts.hiragana || '？';
    if (theme) theme.textContent = drafts.theme;
  }
});

// 制限時間のバー：動かしている間は表示だけ変えて、指を離したときに確定する
const sliderVal = (el) => { const n = Number(el.value); return n > TS_MAX ? 0 : n; };
$app.addEventListener('input', (e) => {
  const el = e.target;
  if (!el.dataset?.slider) return;
  const v = sliderVal(el);
  const box = el.closest('.tslider');
  box.querySelector('.tval').textContent = tsLabel(v);
  box.querySelectorAll('.tick').forEach((t) => t.classList.toggle('on', Number(t.dataset.val) === v));
});
$app.addEventListener('change', (e) => {
  const el = e.target;
  if (!el.dataset?.slider) return;
  handlers.setTime({ ctx: el.dataset.slider, val: String(sliderVal(el)) });
});

$app.addEventListener('keydown', (e) => { // Enter で、コード入力と表示名変更を確定する（変換中は除く）
  if (e.key !== 'Enter' || e.isComposing) return;
  if (e.target.id === 'codeInput') { e.preventDefault(); handlers.join(); }
  if (e.target.id === 'themeInput') e.preventDefault(); // 題材は1行の文章として扱う（改行は入れない）
  if (e.target.id === 'renameInput') { e.preventDefault(); handlers.doRename(); }
});

// 黄色のテロップは、最初にタップしたとき全部を選択する（そのまま打ち直せるように）。2回目のタップからは、普通にカーソルを置く。
let justFocused = false;
$app.addEventListener('focusin', (e) => {
  if (e.target.id !== 'hiraInput' && e.target.id !== 'themeInput') return;
  const el = e.target;
  justFocused = true;
  setTimeout(() => { try { el.select(); el.setSelectionRange(0, el.value.length); } catch { /* 選択できなくても動く */ } }, 0);
  setTimeout(() => { justFocused = false; }, 400);
});
$app.addEventListener('mouseup', (e) => { if (justFocused && (e.target.id === 'hiraInput' || e.target.id === 'themeInput')) e.preventDefault(); }); // 離した瞬間に選択が解けるのを防ぐ

$app.addEventListener('compositionstart', () => { composing = true; });
$app.addEventListener('compositionend', () => {
  composing = false;
  setTimeout(() => { if (pendingRender && !composing) { pendingRender = false; render(); } }, 0);
});

render();
connect();
