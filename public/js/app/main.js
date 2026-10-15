// 画面の入口：操作（クリックや入力）の処理と、起動の組み立て。
// HTML は ui/、状態は core/、通信は net/、描画は app/render.js、動きは effects/ に分けてある。

import { endComposition, fitTheme, render, startComposition } from './render.js';
import { setRenderer, toast } from '../core/hooks.js';
import { drafts, newRoom, state, ui } from '../core/state.js';
import { startBounceLoop, startTimerTicker } from '../effects/ambient.js';
import { startRosterLoop } from '../effects/roster.js';
import { act, sendCritical, sendJoin, setMessageHandler, startConnection } from '../net/connection.js';
import { onMessage } from '../net/messages.js';
import { clientId, loadName, loadSession, saveName } from '../net/storage.js';
import { sliderVal, tsLabel } from '../ui/components/parts.js';

const $app = document.getElementById('app');
state.session = loadSession();
state.prefName = loadName();

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

let lastJoinCode = null;     // 最後に入ろうとした部屋（見つからなかったとき、どの記録を消すか決めるため）

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

$app.addEventListener('compositionstart', () => { startComposition(); });
$app.addEventListener('compositionend', () => { endComposition(); });
setRenderer(render);
setMessageHandler(onMessage);
startRosterLoop();
startBounceLoop();
startTimerTicker();
render();
startConnection();
