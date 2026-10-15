// 画面の入口：通信、操作、描画の組み立て。
// HTML を作る部分は ui/、状態は core/、端末への保存は net/、動きは effects/ に分けてある。

import { isEditing } from '../core/selectors.js';
import { drafts, newRoom, state, ui } from '../core/state.js';
import { startBounceLoop } from '../effects/bounce.js';
import { startRosterLoop } from '../effects/roster.js';
import { startTimerTicker } from '../effects/timerTicker.js';
import { mdToHtml } from '../lib/markdown.js';
import { MARKS } from '../lib/marks.js';
import { clientId, loadName, loadSession, saveName, saveSession } from '../net/storage.js';
import { sliderVal, tsLabel } from '../ui/components/timeSlider.js';
import { entryHtml } from '../ui/pages/entry.js';
import { roomHtml } from '../ui/pages/room.js';

const $app = document.getElementById('app');
state.session = loadSession();
state.prefName = loadName();

let ws = null;
let backoff = 500;
let lastJoinCode = null;     // 最後に入ろうとした部屋（見つからなかったとき、どの記録を消すか決めるため）

// 招待リンク（/?code=XXXX）から開いたら、コードも名前も入れずに、そのまま入る
let pendingLink = (() => {
  const c = (new URLSearchParams(location.search).get('code') ?? '').trim().toUpperCase();
  return /^[A-Z0-9]{4}$/.test(c) ? c : null;
})();

let lastRound = 0, lastTopicKey = '', autoDrawKey = '';
let composing = false, pendingRender = false, toastTimer = null;

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
    else if (state.session && state.autoJoin) sendJoin(state.session.code);
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
  return sendCritical({ t: 'join', code, name: state.prefName, clientId, spectator, playerId: state.session?.code === code ? state.session.playerId : null });
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
      state.session = { code: m.code, playerId: m.playerId };
      saveSession(state.session);
      state.endMessage = null;
      ui.joinOpen = false;
      return;
    case 'state':
      state.view = m.view;
      state.viewAt = performance.now();
      ui.joining = false;
      if (ui.pendingRename !== null && state.view.me.name === ui.pendingRename) { // 表示名の変更が通った
        state.prefName = ui.pendingRename;
        saveName(state.prefName);
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
        if (!state.session || state.session.code === lastJoinCode) { state.session = null; saveSession(null); }
        state.view = null;
      }
      if (m.code === 'banned') {
        state.view = null; state.autoJoin = false;
        state.endMessage = { title: 'この部屋には入れません', body: '主催者が再入室を許可すると、もう一度入れます。', retry: true };
      }
      toast(m.message);
      break;
    case 'needConfirm':
      ui.modal = confirmFor(m);
      break;
    case 'removed':
      state.view = null; state.autoJoin = false; ui.sheet = null; ui.modal = null;
      state.endMessage = { title: '部屋から外されました', body: '主催者が再入室を許可すると、もう一度入れます。', retry: true };
      break;
    case 'closed':
      state.view = null; state.session = null; saveSession(null); ui.sheet = null; ui.modal = null;
      state.endMessage = { title: '部屋が閉じられました', body: '' };
      break;
    case 'left':
      state.view = null; state.autoJoin = false; ui.sheet = null; ui.modal = null;
      break;
  }
  render();
}

// 入力中の内容（下書き）は、状態が届いても消さない。新しいラウンドと、お題が変わったときだけ入れ替える。
function syncDrafts() {
  const v = state.view;
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
  else if (state.view.settings.chooserMode === 'one') body = `まだ正解が選ばれていません（${p.names.join('、')}）。このまま結果を出しますか？`;
  else body = `まだ${p.count}人が未投票です（${p.names.join('、')}）。このまま結果を出しますか？`;
  return { body, ok: '進める', onOk: () => act('advance', { force: true }) };
}

let lastPhaseKey = '';
// ---------- 描画 ----------

function trackPhase() {
  const phase = state.view?.phase ?? '';
  document.body.dataset.phase = phase;
  const key = state.view ? `${state.view.code}:${state.view.round}:${phase}` : '';
  if (key !== lastPhaseKey) {
    ui.sel.clear(); // 段階が変わったら、編集と選択は解く
    ui.editing = false;
    if (state.view?.bombed && (phase === 'reveal' || phase === 'result') && lastPhaseKey.endsWith(':answer')) bomb();
    if (phase === 'vote' && lastPhaseKey.endsWith(':reveal')) startBand();
    if (phase === 'result' && lastPhaseKey.endsWith(':vote') && state.view.result?.winners.length) confetti();
    lastPhaseKey = key;
  }
  if (!isEditing()) { ui.editing = false; ui.sel.clear(); }
  if (state.view && ui.sel.size) { // 消えた・まだ開示されていない回答は、選択から外す
    const ok = new Set(state.view.pool.filter((c) => c.revealed).map((c) => c.answerId));
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

// 投票のはじまりで、背景を紺に反転し、「投票スタート」の帯を一瞬出す。帯は #app の外に置く（描画のたびに作り直されて、動きが途切れないように）。
function startBand() {
  document.querySelector('.startband')?.remove();
  const el = document.createElement('div');
  el.className = 'startband';
  el.setAttribute('aria-hidden', 'true');
  el.innerHTML = `<span>${state.view.settings.chooserMode === 'one' ? '正解を選べ' : '投票スタート'}</span>`;
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
  if (state.view && ui.sheet?.kind === 'howto') loadHowto(); // 遊び方は、初めて開くときに読み込む
  morphInto($app, state.view ? roomHtml() : entryHtml());
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

// 遊び方（public/howto.md）：初めて開くときに読み込んで、控えておく。
let howtoLoading = false;

function loadHowto() {
  if (state.howtoHtml !== null || howtoLoading) return;
  howtoLoading = true;
  fetch('/howto.md').then((r) => (r.ok ? r.text() : Promise.reject(new Error(r.status)))).then((t) => { state.howtoHtml = mdToHtml(t); })
    .catch(() => { state.howtoHtml = '<p class="hint">読み込めませんでした。もう一度開いてください。</p>'; howtoLoading = false; setTimeout(() => { state.howtoHtml = null; }, 0); })
    .finally(() => { howtoLoading = false; if (ui.sheet?.kind === 'howto') render(); });
}

// ---------- 操作 ----------

function confirmPick(kind, id) {
  const name = state.view.players.find((p) => p.id === id)?.name ?? state.view.removed.find((p) => p.id === id)?.name ?? '';
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
    if (!sendCritical({ t: 'create', name: state.prefName, clientId, settings: { ...newRoom } })) return; // つながっていないときは、ポップアップを閉じずに知らせる
    state.autoJoin = true;
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
    state.autoJoin = true;
    if (sendJoin(code, ui.joinWatch)) { ui.joining = true; render(); }
  },
  setJoinWatch(d) { ui.joinWatch = d.val === 'true'; render(); },
  resume() {
    state.autoJoin = true; state.endMessage = null;
    sendJoin(state.session.code);
  },
  openRename() {
    drafts.rename = state.view.me.name;
    ui.sheet = { kind: 'rename' };
    render();
    document.getElementById('renameInput')?.focus();
  },
  doRename() {
    const name = drafts.rename.trim();
    if (!name) return toast('表示名を入力してください');
    if (name === state.view.me.name) { // 変わっていなくても、この名前を次の部屋以降の既定にする
      state.prefName = name; saveName(name); ui.sheet = null; render(); return;
    }
    ui.pendingRename = name;
    act('rename', { name });
  },
  backToEntry() { state.endMessage = null; render(); },
  openMenu() { ui.sheet = { kind: 'menu' }; render(); },
  closeSheet() { ui.sheet = null; render(); },
  scrim(_d, el, e) { if (e.target === el) { ui.sheet = null; render(); } },
  noop() {},
  sheet(d) { ui.sheet = { kind: d.kind }; render(); },
  set(d) { act('setSettings', { patch: { [d.key]: d.val } }); },
  move(d) {
    const ids = state.view.settings.order.filter((id) => state.view.players.some((p) => p.id === id));
    const i = ids.indexOf(d.id), j = i + Number(d.dir);
    if (i < 0 || j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    act('setSettings', { patch: { order: ids } });
  },
  pick(d) { confirmPick(d.kind, d.id); },
  randomPresenter() { ui.sheet = null; act('randomPresenter'); render(); },
  reclaim() {
    ui.sheet = null;
    const who = state.view.phase === 'vote' ? '正解を選ぶ人' : '出題者';
    ui.modal = { body: `${who}の役割を、主催者に戻します。`, ok: '回収する', onOk: () => act('reclaimRole') };
    render();
  },
  randomChooser() { ui.sheet = null; act('randomChooser'); render(); },
  // 参戦／観戦の切り替え（メニューは開いたまま）。回答中までは、すぐ。それ以降は次のラウンドから。
  setSpectate(d) {
    const want = d.val === 'true';
    if (want === Boolean(state.view.me.nextSpectator ?? state.view.me.spectator)) return;
    if (!act('setSpectator', { spectator: want })) return;
    if (!['lobby', 'topic', 'answer', 'result'].includes(state.view.phase) && want !== state.view.me.spectator) toast(`次のラウンドから${want ? '観戦' : '参戦'}になります`);
    render();
  },
  toggleSpectate() { handlers.setSpectate({ val: String(!(state.view.me.nextSpectator ?? state.view.me.spectator)) }); },
  resetRoom() {
    ui.sheet = null;
    ui.modal = { body: '記録と問題数を消して、最初の画面に戻します。参加者と設定は、そのまま残ります。', ok: 'リセットする', danger: true, onOk: () => act('resetRoom') };
    render();
  },
  reportTopic() {
    const t = state.view.topic?.theme;
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
    const ids = state.view.pool.filter((c) => ui.sel.has(c.answerId)).map((c) => c.answerId);
    if (ids.length < 2) return;
    ui.sel.clear();
    act('group', { answerIds: ids });
  },
  ungroupSel() {
    const ids = state.view.pool.filter((c) => ui.sel.has(c.answerId) && c.group).map((c) => c.answerId);
    if (!ids.length) return;
    ui.sel.clear();
    act('ungroup', { answerIds: ids });
  },
  vote(d) {
    const mine = state.view.pool.find((x) => x.answerId === state.view.myVote);
    const tapped0 = state.view.pool.find((x) => x.answerId === d.id);
    if (mine && tapped0 && mine.group && mine.group === tapped0.group) return; // 同じまとまりへは、投票済み
    if (state.view.myVote === d.id) return;
    const c = state.view.pool.find((x) => x.answerId === d.id);
    if (!c) return;
    const one = state.view.settings.chooserMode === 'one';
    ui.modal = { quote: c.text, ok: one ? (state.view.myVote ? '正解を変更' : '正解にする') : (state.view.myVote ? '投票を変更' : '投票する'), onOk: () => act(one ? 'choose' : 'vote', { answerId: d.id }) };
    render();
  },
  advance() { act('advance'); },
  modalOk() { const m = ui.modal; ui.modal = null; render(); m?.onOk?.(); },
  modalCancel() { ui.modal = null; render(); },
  async copyCode() {
    const code = state.view.code;
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
    const url = `${location.origin}/?code=${state.view.code}`; // 開くだけで、この部屋にそのまま入れる
    ui.sheet = null;
    // リンクは文章の中に入れる（url を別に渡すと、「コピー」で落ちる端末がある）
    try {
      if (navigator.share) { await navigator.share({ title: '朝からそれ正解', text: `朝からそれ正解の部屋に入る（部屋コード ${state.view.code}）\n${url}` }); return; }
    } catch { return; } // 共有をやめた場合
    try { await navigator.clipboard.writeText(url); toast('招待リンクをコピーしました'); } catch { toast(url); }
  },
  leave() {
    ui.sheet = null;
    const others = state.view.players.filter((p) => p.id !== state.view.me.id && p.connected);
    if (state.view.me.isHost && others.length > 0) {
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

startRosterLoop();
startBounceLoop();
startTimerTicker();
render();
connect();
