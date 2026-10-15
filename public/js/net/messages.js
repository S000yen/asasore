// サーバーから届くメッセージの処理。

import { requestRender } from '../core/hooks.js';
import { drafts, state, ui } from '../core/state.js';
import { toast } from '../core/toast.js';
import { floatMark } from '../effects/floatMark.js';
import { act, settleCritical } from './connection.js';
import { saveName, saveSession } from './storage.js';

let lastRound = 0, lastTopicKey = '', autoDrawKey = '';

export function onMessage(m) {
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
        if (!state.session || state.session.code === state.lastJoinCode) { state.session = null; saveSession(null); }
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
  requestRender();
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

function confirmFor(m) {
  const p = m.pending;
  let body;
  if (m.phase === 'answer') body = `まだ${p.count}人が未回答です（${p.names.join('、')}）。このまま進みますか？`;
  else if (m.phase === 'reveal') body = `まだ開示されていない回答が${p.count}件あります。このまま投票に進みますか？`;
  else if (state.view.settings.chooserMode === 'one') body = `まだ正解が選ばれていません（${p.names.join('、')}）。このまま結果を出しますか？`;
  else body = `まだ${p.count}人が未投票です（${p.names.join('、')}）。このまま結果を出しますか？`;
  return { body, ok: '進める', onOk: () => act('advance', { force: true }) };
}
