// 画面が共有する状態：サーバーから届いた自分用のビューと、画面だけの状態（シート・入力中の内容など）。
// 読み込んだだけでは、localStorage や DOM には触らない（起動時に main.js が初期値を入れる）。

const initialState = () => ({
  view: null, // サーバーから届いた自分用の状態
  viewAt: 0, // 状態を受け取った時刻（経過時間の表示用）
  session: null, // { code, playerId }（端末に残す。再接続で同じ参加者として戻るため）
  prefName: '', // 自分で決めた表示名。空ならサーバーが「ユーザーN」を付ける
  autoJoin: true,
  endMessage: null, // 入室画面の代わりに出す案内（外された、部屋が閉じた、など）
  lastJoinCode: null, // 最後に入ろうとした部屋（見つからなかったとき、どの記録を消すか決めるため）
  howtoHtml: null, // 遊び方（読み込んだら、HTML にして控えておく）
});
const initialUi = () => ({ joinWatch: false, editing: false, sel: new Set(), createOpen: false, sheet: null, modal: null, toast: null, connected: false, joinOpen: false, joining: false, pendingRename: null });
const initialDrafts = () => ({ code: '', rename: '', answer: '', hiragana: '', theme: '' });
const initialNewRoom = () => ({ presenterMode: 'host', identityMode: 'named', chooserMode: 'all', timeLimit: 0 });

export const state = initialState();
export const ui = initialUi();
export const drafts = initialDrafts();
export const newRoom = initialNewRoom(); // 部屋をつくるときの設定（作成の前に選ぶ）

// 全部を初期値に戻す（テスト用。シナリオごとに、まっさらな状態から始めるため）
export function resetState() {
  Object.assign(state, initialState());
  Object.assign(ui, initialUi());
  Object.assign(drafts, initialDrafts());
  Object.assign(newRoom, initialNewRoom());
}
