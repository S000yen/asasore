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
const newRoom = { presenterMode: 'host', identityMode: 'named' }; // 部屋をつくるときの設定（作成の前に選ぶ）
const ui = { createOpen: false, sheet: null, modal: null, toast: null, connected: false, joinOpen: false, joining: false, pendingRename: null };
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
    if (pendingLink) joinFromLink();
    else if (session && autoJoin) sendJoin(session.code);
    render();
  };
  sock.onmessage = (e) => {
    try { onMessage(JSON.parse(e.data)); } catch (err) { console.error(err); }
  };
  sock.onclose = () => {
    if (ws !== sock) return;
    ws = null;
    ui.connected = false;
    render();
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 5000);
  };
}

const sendRaw = (m) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); };
const act = (a, extra = {}) => sendRaw({ t: 'act', a, ...extra });

// 同じ端末で前に入った部屋なら、同じ参加者として戻る（playerId を渡す）
function sendJoin(code) {
  lastJoinCode = code;
  sendRaw({ t: 'join', code, name: prefName, clientId, playerId: session?.code === code ? session.playerId : null });
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
    case 'joined':
      session = { code: m.code, playerId: m.playerId };
      saveSession(session);
      endMessage = null;
      ui.joinOpen = false;
      return;
    case 'state':
      view = m.view;
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
    case 'error':
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
  else body = `まだ${p.count}人が未投票です（${p.names.join('、')}）。このまま結果を出しますか？`;
  return { body, ok: '進める', onOk: () => act('advance', { force: true }) };
}

// ---------- 描画 ----------

function render() {
  if (composing) { pendingRender = true; return; } // 日本語入力の変換中は作り直さない
  const focused = document.activeElement;
  const keep = focused && INPUT_IDS.includes(focused.id) ? focused : null;
  $app.innerHTML = view ? roomHtml() : entryHtml();
  // 入力中の欄は、作り直さずそのまま戻す（キーボードやカーソルを保つため）
  if (keep) {
    const fresh = document.getElementById(keep.id);
    if (fresh) fresh.replaceWith(keep);
  }
  fitTheme();
}

// 題材の欄は、長くても全部見えるよう、文字の量に合わせて高さを変える
function fitTheme() {
  const el = document.getElementById('themeInput');
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight + 4}px`;
}

const chips = (list, mark) => `<div class="chips">${list.map((p) =>
  `<span class="chip ${p.connected ? '' : 'away'}">${esc(p.name)}${p.isHost ? '<span class="tag">主催者</span>' : ''}${mark && mark(p) ? '<span class="mark">✓</span>' : ''}${p.connected ? '' : '<span class="tag">離席中</span>'}</span>`).join('')}</div>`;

const ICON_REDRAW = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.4-5.7"/><path d="M20 4v5h-5"/></svg>';
// 回答の長さで文字の大きさを変える（短い答えは大きく、長い答えは小さく）
const ICON_TRASH = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 13h10l1-13"/><path d="M10 11v6M14 11v6"/></svg>';
const SVG_ATTR = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';
const ICON_HAMMER = `<svg ${SVG_ATTR}><path d="m15 12-8.373 8.373a1 1 0 1 1-3-3L12 9"/><path d="m18 15 4-4"/><path d="m21.5 11.5-1.914-1.914A2 2 0 0 1 19 8.172V7l-2.26-2.26a6 6 0 0 0-4.202-1.756L9 2.96l.92.82A6.18 6.18 0 0 1 12 8.4V10l2 2h1.172a2 2 0 0 1 1.414.586L18.5 14.5"/></svg>`;
const ICON_DOOR = `<svg ${SVG_ATTR}><path d="M13 4h3a2 2 0 0 1 2 2v14"/><path d="M2 20h3"/><path d="M13 20h9"/><path d="M10 12v.01"/><path d="M13 4.562v16.157a1 1 0 0 1-1.242.97L5 20V5.562a2 2 0 0 1 1.515-1.94l4-1A2 2 0 0 1 13 4.561Z"/></svg>`;
const ICON_SEND = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 3 10.5 13.5"/><path d="M21 3l-6.5 18-4-7.5L3 9.5z"/></svg>';
const sizeOf = (text) => { const n = [...String(text)].length; return n <= 8 ? 'lg' : n <= 22 ? 'md' : 'sm'; };

// 参加者の進み具合（回答済み・投票済み）。枠は付けず、見出しの横に数だけ出す
const progress = (label, list, done) => `<div class="progress"><h2>${label} ${list.filter(done).length}/${list.length}</h2>${chips(list, done)}</div>`;

const telop = (t) => t
  ? `<div class="telop"><div class="tile" id="tpTile">${esc(t.hiragana || '？')}</div><div class="telop-text"><span class="tiny">で始まる</span><strong id="tpTheme">${esc(t.theme)}</strong><span class="tiny">といえば？</span></div></div>`
  : '';

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
  const createDialog = ui.createOpen && !ui.joining ? `<div class="scrim dialog" data-do="noop"><div class="sheet">
      <h3>部屋をつくる</h3>
      <div class="stack">
        <h2>出題者</h2>${seg('presenterMode', [['host', '毎回主催者'], ['rotation', '順番に回す']])}
        <h2>回答の見せ方</h2>${seg('identityMode', [['named', '記名'], ['anonymous', '匿名']])}
      </div>
      <div class="btns" style="margin-top:18px"><button class="btn" data-do="closeCreate">キャンセル</button><button class="btn primary" data-do="create">作成</button></div>
    </div></div>` : '';
  const dialog = ui.joinOpen && !ui.joining ? `<div class="scrim dialog" data-do="noop"><div class="sheet"><button class="x" data-do="closeJoin" aria-label="閉じる">×</button>
      <label class="field"><span>部屋コード</span><input id="codeInput" type="text" data-draft="code" maxlength="4" autocapitalize="characters" autocorrect="off" autocomplete="off" spellcheck="false" value="${esc(drafts.code)}"></label>
      <button class="btn primary block" style="margin-top:16px" data-do="join">入る</button>
    </div></div>` : '';
  return `<div class="entry">
    <div class="entry-top">
      <div class="telop hero"><div class="tile">あ</div><h1 class="hero-title">朝からそれ正解</h1></div>
    </div>
    ${body}
    ${ui.connected ? '' : '<p class="hint center-text">サーバーにつなぎ直しています。</p>'}
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
    <header class="bar">
      <button class="room" data-do="copyCode" aria-label="部屋番号${esc(v.code)}をコピー"><span class="room-label">部屋</span><b class="code">${esc(v.code)}</b></button>
      <div class="round">${v.round ? `第${v.round}問` : ''}</div>
      <div class="bar-right">
        ${v.history.length ? '<button class="textbtn" data-do="sheet" data-kind="history">記録</button>' : ''}
        <button class="icon" data-do="openMenu" aria-label="メニュー">☰</button>
      </div>
    </header>
    ${ui.connected ? '' : '<p class="conn">再接続しています。</p>'}
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
  const v = view, s = v.settings;
  const rule = `${s.presenterMode === 'host' ? '毎回主催者が出題' : '参加順に出題'}・${s.identityMode === 'anonymous' ? '匿名' : '記名'}`;
  return `
    <section class="card"><h2>参加者 ${v.players.length}人</h2>${chips(v.players)}</section>
    ${v.me.isHost
      ? `<button class="rule" data-do="sheet" data-kind="settings"><span>ルール</span><span class="rule-body">${rule}</span><span class="chev">›</span></button>`
      : `<p class="rule static"><span>ルール</span><span class="rule-body">${rule}</span></p>`}
    <button class="btn small center" data-do="share">招待リンクを共有する</button>
`;
}

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
  return `
    ${telop(v.topic)}
    <div class="answerbox">
      <textarea id="answerInput" data-draft="answer" rows="3" maxlength="100" placeholder="答えを入力" ${v.myAnswer !== null ? 'readonly' : ''}>${esc(drafts.answer)}</textarea>
      <div class="box-actions">${v.myAnswer !== null ? '<button class="btn small" data-do="withdraw">取り下げる</button>' : '<button class="btn primary small" data-do="submitAnswer">回答する</button>'}</div>
    </div>
    ${progress('回答状況', v.players, (p) => p.answered)}`;
}

// 自分の回答は、開示のあいだ、一番上に出す
const myCard = () => (view.myAnswer !== null
  ? `<div class="mycard"><span class="mycard-label">あなたの回答</span><span class="text ${sizeOf(view.myAnswer)}">${esc(view.myAnswer)}</span></div>`
  : '');

// 回答のプール：全部の回答が、位置を変えずに並ぶ。未開示は黒マス、開示されたものだけ中身が見える。
function poolHtml() {
  const v = view, anon = v.settings.identityMode === 'anonymous';
  const cells = v.pool.map((c) => {
    if (!c.revealed) {
      const name = c.author ? `<span class="cell-name">${esc(c.author)}</span>` : '';
      const cls = `cell dark${c.mine ? ' mine' : ''}`;
      return c.canReveal
        ? `<button class="${cls} tap" data-do="${anon ? 'revealSelected' : 'revealOwn'}" data-id="${esc(c.answerId)}">${name}<span class="cell-hint">タップで開示</span></button>`
        : `<div class="${cls}">${name}</div>`;
    }
    const wide = [...c.text].length > 10 ? ' wide' : '';
    const picked = v.myVote === c.answerId;
    const body = `${c.mine ? '<span class="state me">あなた</span>' : ''}${picked ? '<span class="state pick">投票</span>' : ''}<span class="text ${sizeOf(c.text)}">${esc(c.text)}</span>${c.author ? `<span class="by">${esc(c.author)}</span>` : ''}`;
    return c.canVote
      ? `<button class="cell open${wide}${picked ? ' picked' : ''}" data-do="vote" data-id="${esc(c.answerId)}">${body}</button>`
      : `<div class="cell open${wide}${c.mine ? ' mine' : ''}">${body}</div>`;
  }).join('');
  return `<section class="pool">${cells}</section>`;
}

function revealHtml() {
  const v = view, host = v.me.isHost;
  const total = v.pool.length;
  return `
    ${telop(v.topic)}
    ${myCard()}
    <div class="listhead"><h2>開示済み ${total - v.unrevealedCount}/${total}</h2>${host && v.unrevealedCount > 0 ? '<button class="btn small" data-do="revealAll">残りを全員分開示</button>' : ''}</div>
    ${poolHtml()}
`;
}

function voteHtml() {
  const v = view;
  return `
    ${telop(v.topic)}
    <div class="listhead"><h2>正解だと思う回答に投票</h2></div>
    ${poolHtml()}
    ${progress('投票状況', v.players, (p) => p.voted)}`;
}

function resultHtml() {
  const v = view, r = v.result;
  if (!r) return '<p class="hint">結果を集計しています。</p>';
  const winners = new Set(r.winners);
  const rows = [...r.tallies].sort((a, b) => b.votes - a.votes).map((t) => {
    const won = winners.has(t.answerId);
    return `<div class="answer ${won ? 'won' : 'lost'}">
      ${won ? '<span class="stamp">正解</span>' : ''}
      <span class="text ${won ? 'xl' : sizeOf(t.text)}">${esc(t.text)}</span><span class="foot"><span class="by">${esc(t.author)}</span><span class="votes">${t.votes}票</span></span></div>`;
  }).join('');
  return `
    ${telop(v.topic)}
    ${r.tie ? '<p class="hint">同票：どれも正解</p>' : ''}
    ${r.winners.length === 0 ? '<p class="hint">正解なし（投票がありません）</p>' : ''}
    <section class="stack">${rows}</section>`;
}

function actionBar() {
  const v = view, host = v.me.isHost;
  let btn = '', meta = '';
  switch (v.phase) {
    case 'lobby':
      if (host) {
        const n = v.players.filter((p) => p.connected).length;
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
        btn = `<button class="btn primary block" data-do="advance" ${left > 0 ? 'disabled' : ''}>投票へ進む</button>`;
      }
      break;
    case 'vote':
      if (host) { btn = '<button class="btn primary block" data-do="advance">結果を見る</button>' }
      break;
    case 'result':
      if (host) btn = '<button class="btn primary block" data-do="advance">次のラウンドへ</button>';
      break;
  }
  // 題決めの間は、出題者を丸いチップで出す。出題者本人と主催者は、タップして変更できる。
  let who = '';
  if (v.phase === 'topic') {
    const name = v.players.find((p) => p.id === v.presenterId)?.name ?? '';
    const can = v.me.isHost || v.me.isPresenter;
    const inner = `<span class="av">${esc([...name][0] ?? '?')}</span><span class="who-text">出題者 <b>${esc(name)}</b></span>${can ? `<span class="who-edit">${ICON_SEND}変更</span>` : ''}`;
    who = can ? `<button class="who" data-do="sheet" data-kind="presenter">${inner}</button>` : `<div class="who">${inner}</div>`;
  }
  return btn || who ? `<div class="action"><div>${who}${meta ? `<p class="meta">${meta}</p>` : ''}${btn}</div></div>` : '';
}

// ---------- シート（メニューなど）と確認 ----------

function sheetHtml() {
  if (!ui.sheet) return '';
  const v = view, k = ui.sheet.kind, host = v.me.isHost;
  const others = v.players.filter((p) => p.id !== v.me.id);
  const pick = (kind, list) => list.map((p) => `<button class="btn" data-do="pick" data-kind="${kind}" data-id="${esc(p.id)}">${esc(p.name)}${p.connected === false ? '（離席中）' : ''}</button>`).join('') || '<p class="hint">対象の人がいません。</p>';
  let inner = '';
  if (k === 'menu') {
    const item = (cls, attrs, label, side = '') => `<button class="item ${cls}" ${attrs}><span>${label}</span>${side ? `<span class="side">${side}</span>` : ''}</button>`;
    inner = `<h3>メニュー</h3><div class="menu-list">
      <div class="group">
        ${item('', 'data-do="share"', '招待リンクを共有')}
        ${item('', 'data-do="openRename"', '表示名を変える', esc(v.me.name))}
      </div>
      ${host ? `<div class="group"><p class="group-label">主催者</p>
        ${item('', 'data-do="sheet" data-kind="settings"', 'ルール設定')}
        ${item('', 'data-do="sheet" data-kind="transfer"', '主催者を譲る')}
        ${item('', 'data-do="sheet" data-kind="remove"', '参加者を外す')}
        ${v.removed.length ? item('', 'data-do="sheet" data-kind="allow"', '再入室を許可', `${v.removed.length}人`) : ''}
      </div>` : ''}
      <div class="group">
        ${item('danger', 'data-do="leave"', '退出する')}
        ${host ? item('danger', 'data-do="closeRoom"', '部屋を閉じる') : ''}
      </div>
    </div>`;
  } else if (k === 'history') {
    inner = `<h3>これまでの記録</h3><div class="history">${v.history.map((h) => `
      <article class="rec">
        <div class="rec-head"><span class="rec-no">第${h.round}問</span><span class="rec-topic"><b>${esc(h.topic.hiragana)}</b>で始まる ${esc(h.topic.theme)}</span></div>
        ${h.entries.map((e) => `<div class="rec-row ${e.won ? 'won' : ''}"><span class="rec-text">${esc(e.text)}<small>${esc(e.author)}</small></span><span class="rec-votes">${e.won ? '<i>正解</i>' : ''}${e.votes}票</span></div>`).join('')}
      </article>`).join('')}</div>`;
  } else if (k === 'rename') {
    inner = `<h3>表示名を変える</h3><div class="stack">
      <label class="field"><span>表示名</span><input id="renameInput" type="text" data-draft="rename" maxlength="20" autocomplete="off" value="${esc(drafts.rename)}"></label>
      <button class="btn primary block" data-do="doRename">変更する</button></div>`;
  } else if (k === 'settings') {
    const s = v.settings, locked = !['lobby', 'result'].includes(v.phase);
    const seg = (key, opts) => `<div class="seg">${opts.map(([val, label]) => `<button class="btn small ${s[key] === val ? 'on' : ''}" data-do="set" data-key="${key}" data-val="${val}" ${locked ? 'disabled' : ''}>${label}</button>`).join('')}</div>`;
    const ids = s.order.filter((id) => v.players.some((p) => p.id === id));
    const order = s.presenterMode === 'rotation' ? `<h2>順番（上から）</h2><ul class="order">${ids.map((id, i) => `<li>${esc(v.players.find((p) => p.id === id).name)}<span>
      <button class="btn small" data-do="move" data-id="${esc(id)}" data-dir="-1" ${i === 0 || locked ? 'disabled' : ''} aria-label="上へ">↑</button>
      <button class="btn small" data-do="move" data-id="${esc(id)}" data-dir="1" ${i === ids.length - 1 || locked ? 'disabled' : ''} aria-label="下へ">↓</button></span></li>`).join('')}</ul>` : '';
    inner = `<h3>部屋設定</h3><div class="stack">
      ${locked ? '<p class="hint">ラウンド中は変更できません</p>' : ''}
      <h2>出題者</h2>${seg('presenterMode', [['host', '毎ラウンド主催者'], ['rotation', '順番に回す']])}
      <h2>回答の見せ方</h2>${seg('identityMode', [['named', '記名'], ['anonymous', '匿名']])}
      ${order}</div>`;
  } else if (k === 'transfer') {
    inner = `<h3>主催者を譲渡する</h3><div class="menu">${pick('transfer', others.filter((p) => p.connected))}</div>`;
  } else if (k === 'remove') {
    inner = `<h3>参加者を外す</h3><div class="menu">${pick('remove', others)}</div>`;
  } else if (k === 'allow') {
    inner = `<h3>再入室を許可する</h3><div class="menu">${pick('allow', v.removed)}</div>`;
  } else if (k === 'presenter') {
    inner = `<h3>出題者を指名する</h3><div class="menu">
      ${host ? '<button class="btn" data-do="randomPresenter">ランダムで指名する</button>' : ''}
      ${pick('presenter', v.players.filter((p) => p.connected && p.id !== v.presenterId))}</div>`;
  }
  return `<div class="scrim" data-do="scrim"><div class="sheet"><button class="x" data-do="closeSheet" aria-label="閉じる">×</button>${inner}</div></div>`;
}

function modalHtml() {
  const m = ui.modal;
  if (!m) return '';
  return `<div class="scrim dialog" data-do="noop"><div class="sheet">
    <p>${esc(m.body)}</p>
    <div class="btns"><button class="btn" data-do="modalCancel">やめる</button><button class="btn ${m.danger ? 'danger' : 'primary'}" data-do="modalOk">${esc(m.ok)}</button></div>
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
    presenter: { body: `${name}さんに出題者を任せます。`, ok: '任せる', go: () => act('setPresenter', { to: id }) },
  }[kind];
  ui.sheet = null;
  ui.modal = { body: spec.body, ok: spec.ok, danger: spec.danger, onOk: spec.go };
  render();
}

const handlers = {
  openCreate() { ui.createOpen = true; render(); },
  closeCreate() { ui.createOpen = false; render(); },
  newSet(d) { newRoom[d.key] = d.val; render(); },
  create() {
    autoJoin = true;
    ui.createOpen = false;
    sendRaw({ t: 'create', name: prefName, clientId, settings: { ...newRoom } });
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
    sendJoin(code);
  },
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
  vote(d) { act('vote', { answerId: d.id }); },
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
