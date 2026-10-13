'use strict';

// ---------- 状態 ----------

const STORE = 'asaso.session';
const INPUT_IDS = ['nameInput', 'codeInput', 'answerInput', 'hiraInput', 'themeInput'];
const $app = document.getElementById('app');

const loadSession = () => {
  try { return JSON.parse(localStorage.getItem(STORE)); } catch { return null; }
};
const saveSession = (s) => {
  try { s ? localStorage.setItem(STORE, JSON.stringify(s)) : localStorage.removeItem(STORE); } catch { /* 保存できなくても動く */ }
};

let ws = null;
let view = null;            // サーバーから届いた自分用の状態
let session = loadSession(); // { code, playerId, name }（端末に残す。再接続で同じ参加者として戻るため）
let autoJoin = true;
let backoff = 500;
let endMessage = null;       // 入室画面の代わりに出す案内（外された、部屋が閉じた、など）
const ui = { sheet: null, modal: null, toast: null, connected: false };
const drafts = {
  name: session?.name ?? '',
  code: (new URLSearchParams(location.search).get('code') ?? '').toUpperCase().slice(0, 4),
  answer: '', hiragana: '', theme: '',
};
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
    if (session && autoJoin) sendRaw({ t: 'join', code: session.code, name: session.name, playerId: session.playerId });
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

// スマホはアプリを切り替えると通信が止まる。戻ってきたら接続を確かめ、入り直して最新の状態をもらう。
function wake() {
  if (document.hidden) return;
  if (!ws || ws.readyState > 1) { connect(); return; }
  if (view && session) sendRaw({ t: 'join', code: session.code, name: session.name, playerId: session.playerId });
}
document.addEventListener('visibilitychange', wake);
window.addEventListener('online', wake);
window.addEventListener('pageshow', wake);

function onMessage(m) {
  switch (m.t) {
    case 'joined':
      session = { code: m.code, playerId: m.playerId, name: drafts.name.trim() || session?.name || '' };
      saveSession(session);
      endMessage = null;
      return;
    case 'state':
      view = m.view;
      syncDrafts();
      break;
    case 'notice':
      toast(m.text);
      return;
    case 'error':
      if (m.code === 'no_room') { session = null; saveSession(null); view = null; }
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
}

const chips = (list, mark) => `<div class="chips">${list.map((p) =>
  `<span class="chip ${p.connected ? '' : 'away'}">${esc(p.name)}${p.isHost ? '<span class="tag">主催者</span>' : ''}${mark && mark(p) ? '<span class="mark">✓</span>' : ''}${p.connected ? '' : '<span class="tag">離席中</span>'}</span>`).join('')}</div>`;

const telop = (t) => t
  ? `<div class="telop"><div class="tile" id="tpTile">${esc(t.hiragana || '？')}</div><div class="telop-text"><span class="tiny">で始まる</span><strong id="tpTheme">${esc(t.theme)}</strong><span class="tiny">といえば？</span></div></div>`
  : '';

function entryHtml() {
  if (endMessage) return endHtml();
  const resume = session ? `<button class="btn block" data-do="resume">前の部屋（${esc(session.code)}）に戻る</button>` : '';
  return `<div class="entry">
    <h1 class="title">朝からそれ正解<small>頭文字のお題に、みんなで「正解」を出し合うゲームです。</small></h1>
    <div class="card stack">
      <label class="field"><span>名前</span><input id="nameInput" type="text" data-draft="name" maxlength="20" autocomplete="nickname" value="${esc(drafts.name)}"></label>
      <button class="btn primary block" data-do="create">部屋をつくる</button>
    </div>
    <div class="card stack">
      <label class="field"><span>部屋コード</span><input id="codeInput" type="text" data-draft="code" maxlength="4" autocapitalize="characters" autocomplete="off" value="${esc(drafts.code)}"></label>
      <button class="btn block" data-do="join">コードで入る</button>
    </div>
    ${resume}
    ${ui.connected ? '' : '<p class="hint">サーバーにつなぎ直しています。</p>'}
    ${toastHtml()}
  </div>`;
}

function endHtml() {
  const e = endMessage;
  return `<div class="end">
    <h1 class="title" style="font-size:28px">${esc(e.title)}</h1>
    ${e.body ? `<p class="hint">${esc(e.body)}</p>` : ''}
    ${e.retry && session ? '<button class="btn primary block" data-do="resume">もう一度入る</button>' : ''}
    <button class="btn block" data-do="backToEntry">入室画面に戻る</button>
    ${toastHtml()}
  </div>`;
}

function roomHtml() {
  const v = view;
  return `
    <header class="bar">
      <div class="room"><span class="room-label">部屋</span><b class="code">${esc(v.code)}</b>${v.round ? `<span class="round">第${v.round}問</span>` : ''}</div>
      <button class="icon" data-do="openMenu" aria-label="メニュー">☰</button>
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
  return `
    <section class="card"><h2>参加者 ${v.players.length}人</h2>${chips(v.players)}</section>
    <section class="card stack">
      <h2>ルール</h2>
      <p class="hint" style="color:inherit">出題者：${s.presenterMode === 'host' ? '毎ラウンド主催者' : '参加順に交代'}<br>回答：${s.identityMode === 'anonymous' ? '匿名（結果発表で作者を明かします）' : '記名'}</p>
      <button class="btn small" data-do="share">招待リンクを共有する</button>
    </section>
    ${v.me.isHost ? '<p class="hint">ルールは右上のメニューから変えられます。</p>' : '<p class="hint">主催者が始めるのを待っています。</p>'}`;
}

function topicHtml() {
  const v = view;
  if (!v.me.isPresenter) {
    const name = v.players.find((p) => p.id === v.presenterId)?.name ?? '出題者';
    return `
      <div class="telop waiting"><div class="telop-text"><strong>${esc(name)}さんがお題を考えています</strong></div></div>
      ${v.me.isHost ? '<button class="btn" data-do="sheet" data-kind="presenter">出題者を変える</button>' : ''}`;
  }
  return `
    ${telop({ hiragana: drafts.hiragana, theme: drafts.theme })}
    <section class="card stack">
      <div class="row">
        <label class="field"><span>ひらがな</span><input id="hiraInput" class="hira-input" type="text" data-draft="hiragana" maxlength="1" value="${esc(drafts.hiragana)}"></label>
        <button class="btn small" data-do="draw" data-part="hiragana">引き直す</button>
      </div>
      <div class="row">
        <label class="field"><span>題材</span><input id="themeInput" type="text" data-draft="theme" maxlength="40" value="${esc(drafts.theme)}"></label>
        <button class="btn small" data-do="draw" data-part="theme">引き直す</button>
      </div>
      <button class="btn block" data-do="draw" data-part="both">まとめて引き直す</button>
    </section>
    <button class="btn" data-do="sheet" data-kind="presenter">出題者を他の人に任せる</button>`;
}

function answerHtml() {
  const v = view;
  const answered = v.players.filter((p) => p.answered).length;
  return `
    ${telop(v.topic)}
    <section class="card stack">
      <textarea id="answerInput" data-draft="answer" rows="3" maxlength="100" placeholder="答えを入力">${esc(drafts.answer)}</textarea>
      <button class="btn primary block" data-do="submitAnswer">${v.myAnswer !== null ? '回答を更新する' : '回答する'}</button>
      ${v.myAnswer !== null ? '<button class="link" data-do="withdraw">回答を取り下げる</button>' : ''}
    </section>
    <section class="card"><h2>回答状況 ${answered}/${v.players.length}</h2>${chips(v.players, (p) => p.answered)}</section>`;
}

function revealHtml() {
  const v = view, anon = v.settings.identityMode === 'anonymous', host = v.me.isHost;
  const pending = v.unrevealed.map((a) => {
    const canReveal = anon ? host : a.mine;
    const note = a.mine ? (anon && !host ? 'あなたの回答（主催者が開示します）' : 'あなたの回答') : '';
    return `<div class="answer ${a.mine ? 'mine' : ''}"><span class="text">${esc(a.text)}</span>${note ? `<span class="by">${note}</span>` : ''}${
      canReveal ? `<button class="btn small" style="margin-top:10px" data-do="${anon ? 'revealSelected' : 'revealOwn'}" data-id="${esc(a.answerId)}">開示する</button>` : ''}</div>`;
  }).join('');
  const shown = v.answers.map((a) => `<div class="answer ${a.mine ? 'mine' : ''}"><span class="text">${esc(a.text)}</span>${a.author ? `<span class="by">${esc(a.author)}</span>` : ''}</div>`).join('');
  const hiddenOthers = v.unrevealedCount - v.unrevealed.length;
  return `
    ${telop(v.topic)}
    ${v.unrevealedCount > 0 && host ? '<button class="btn" data-do="revealAll">残りを全員分開示する</button>' : ''}
    ${pending ? `<section class="stack"><h2>まだ開示していない回答</h2>${pending}</section>` : ''}
    ${hiddenOthers > 0 && !host ? `<p class="hint">ほかに開示されていない回答が${hiddenOthers}件あります。</p>` : ''}
    <section class="stack"><h2>開示された回答 ${v.answers.length}件</h2>${shown || '<p class="hint">まだありません。</p>'}</section>`;
}

function voteHtml() {
  const v = view;
  const voted = v.players.filter((p) => p.voted).length;
  const cards = v.answers.map((a) => {
    const picked = v.myVote === a.answerId;
    return `<button class="answer ${picked ? 'picked' : ''} ${a.mine ? 'mine' : ''}" data-do="vote" data-id="${esc(a.answerId)}" ${a.mine ? 'disabled' : ''}>
      <span class="state">${a.mine ? 'あなたの回答' : picked ? '投票済み' : ''}</span><span class="text">${esc(a.text)}</span>${a.author ? `<span class="by">${esc(a.author)}</span>` : ''}</button>`;
  }).join('');
  return `
    ${telop(v.topic)}
    <section class="stack"><h2>いちばん「正解」だと思う回答に投票</h2>${cards}</section>
    <section class="card"><h2>投票状況 ${voted}/${v.players.length}</h2>${chips(v.players, (p) => p.voted)}</section>`;
}

function resultHtml() {
  const v = view, r = v.result;
  if (!r) return '<p class="hint">結果を集計しています。</p>';
  const winners = new Set(r.winners);
  const rows = [...r.tallies].sort((a, b) => b.votes - a.votes).map((t) => `
    <div class="answer ${winners.has(t.answerId) ? 'won' : ''}">
      ${winners.has(t.answerId) ? '<span class="stamp">正解</span>' : ''}
      <span class="text">${esc(t.text)}</span><span class="foot"><span class="by">${esc(t.author)}</span><span class="votes">${t.votes}票</span></span></div>`).join('');
  return `
    ${telop(v.topic)}
    ${r.tie ? '<p class="hint">同票でした。同票の回答がどれも正解です。</p>' : ''}
    ${r.winners.length === 0 ? '<p class="hint">投票がなかったため、正解は決まりませんでした。</p>' : ''}
    <section class="stack">${rows}</section>`;
}

function actionBar() {
  const v = view, host = v.me.isHost;
  let btn = '', meta = '';
  switch (v.phase) {
    case 'lobby':
      if (host) {
        const n = v.players.filter((p) => p.connected).length;
        btn = `<button class="btn primary block" data-do="advance" ${n < 2 ? 'disabled' : ''}>はじめる</button>`;
        meta = n < 2 ? '2人以上で始められます' : '';
      }
      break;
    case 'topic':
      if (v.me.isPresenter) btn = '<button class="btn primary block" data-do="confirmTopic">この題で決定</button>';
      break;
    case 'answer':
      if (host) { btn = '<button class="btn primary block" data-do="advance">開示へ進む</button>'; meta = `${v.players.filter((p) => p.answered).length}/${v.players.length}人が回答済み`; }
      break;
    case 'reveal':
      if (host) btn = '<button class="btn primary block" data-do="advance">投票へ進む</button>';
      break;
    case 'vote':
      if (host) { btn = '<button class="btn primary block" data-do="advance">結果を見る</button>'; meta = `${v.players.filter((p) => p.voted).length}/${v.players.length}人が投票済み`; }
      break;
    case 'result':
      if (host) btn = '<button class="btn primary block" data-do="advance">次のラウンドへ</button>';
      break;
  }
  return btn ? `<div class="action"><div>${meta ? `<p class="meta">${meta}</p>` : ''}${btn}</div></div>` : '';
}

// ---------- シート（メニューなど）と確認 ----------

function sheetHtml() {
  if (!ui.sheet) return '';
  const v = view, k = ui.sheet.kind, host = v.me.isHost;
  const others = v.players.filter((p) => p.id !== v.me.id);
  const pick = (kind, list) => list.map((p) => `<button class="btn" data-do="pick" data-kind="${kind}" data-id="${esc(p.id)}">${esc(p.name)}${p.connected === false ? '（離席中）' : ''}</button>`).join('') || '<p class="hint">対象の人がいません。</p>';
  let inner = '';
  if (k === 'menu') {
    inner = `<h3>メニュー</h3><div class="menu">
      <button class="btn" data-do="share">招待リンクを共有する</button>
      ${host ? `
        <button class="btn" data-do="sheet" data-kind="settings">部屋設定</button>
        <button class="btn" data-do="sheet" data-kind="transfer">主催者を譲渡する</button>
        <button class="btn" data-do="sheet" data-kind="remove">参加者を外す</button>
        ${v.removed.length ? '<button class="btn" data-do="sheet" data-kind="allow">再入室を許可する</button>' : ''}
        <button class="btn danger" data-do="closeRoom">部屋を閉じる</button>` : ''}
      <button class="btn danger" data-do="leave">退出する</button>
    </div>`;
  } else if (k === 'settings') {
    const s = v.settings, locked = !['lobby', 'result'].includes(v.phase);
    const seg = (key, opts) => `<div class="seg">${opts.map(([val, label]) => `<button class="btn small ${s[key] === val ? 'on' : ''}" data-do="set" data-key="${key}" data-val="${val}" ${locked ? 'disabled' : ''}>${label}</button>`).join('')}</div>`;
    const ids = s.order.filter((id) => v.players.some((p) => p.id === id));
    const order = s.presenterMode === 'rotation' ? `<h2>順番（上から）</h2><ul class="order">${ids.map((id, i) => `<li>${esc(v.players.find((p) => p.id === id).name)}<span>
      <button class="btn small" data-do="move" data-id="${esc(id)}" data-dir="-1" ${i === 0 || locked ? 'disabled' : ''} aria-label="上へ">↑</button>
      <button class="btn small" data-do="move" data-id="${esc(id)}" data-dir="1" ${i === ids.length - 1 || locked ? 'disabled' : ''} aria-label="下へ">↓</button></span></li>`).join('')}</ul>` : '';
    inner = `<h3>部屋設定</h3><div class="stack">
      ${locked ? '<p class="hint">ラウンドの途中は変更できません。結果発表のあとに変えられます。</p>' : ''}
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
  return `<div class="scrim" data-do="scrim"><div class="sheet">${inner}<button class="link" style="margin-top:8px" data-do="closeSheet">閉じる</button></div></div>`;
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
  create() {
    const name = drafts.name.trim();
    if (!name) return toast('名前を入力してください');
    autoJoin = true;
    sendRaw({ t: 'create', name });
  },
  join() {
    const name = drafts.name.trim(), code = drafts.code.trim().toUpperCase();
    if (!name) return toast('名前を入力してください');
    if (code.length < 4) return toast('部屋コードを4文字で入力してください');
    autoJoin = true;
    sendRaw({ t: 'join', code, name, playerId: session?.code === code ? session.playerId : null });
  },
  resume() {
    autoJoin = true; endMessage = null;
    sendRaw({ t: 'join', code: session.code, name: session.name, playerId: session.playerId });
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
  draw(d) { act('drawTopic', { part: d.part, hiragana: drafts.hiragana, theme: drafts.theme }); },
  confirmTopic() { act('confirmTopic', { hiragana: drafts.hiragana, theme: drafts.theme }); },
  submitAnswer() {
    const text = drafts.answer.trim();
    if (!text) return toast('答えを入力してください');
    act('submitAnswer', { text });
  },
  withdraw() { act('withdrawAnswer'); drafts.answer = ''; },
  revealOwn() { act('revealOwn'); },
  revealSelected(d) { act('revealSelected', { answerId: d.id }); },
  revealAll() { act('revealAll'); },
  vote(d) { act('vote', { answerId: d.id }); },
  advance() { act('advance'); },
  modalOk() { const m = ui.modal; ui.modal = null; render(); m?.onOk?.(); },
  modalCancel() { ui.modal = null; render(); },
  async share() {
    const url = `${location.origin}/?code=${view.code}`;
    ui.sheet = null;
    try {
      if (navigator.share) { await navigator.share({ title: '朝からそれ正解', text: `部屋コード ${view.code}`, url }); return; }
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
  drafts[key] = e.target.value;
  if (key === 'hiragana' || key === 'theme') { // お題のプレビューだけ、作り直さずに書き換える
    const tile = document.getElementById('tpTile'), theme = document.getElementById('tpTheme');
    if (tile) tile.textContent = drafts.hiragana || '？';
    if (theme) theme.textContent = drafts.theme;
  }
});

$app.addEventListener('compositionstart', () => { composing = true; });
$app.addEventListener('compositionend', () => {
  composing = false;
  setTimeout(() => { if (pendingRender && !composing) { pendingRender = false; render(); } }, 0);
});

render();
connect();
