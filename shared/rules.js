// サーバーと画面が、同じ数字・選択肢で動くための規則。
// 画面の入力欄の上限（maxlength）や、制限時間のバーの範囲も、ここから決める。

// ---------- 人数・部屋コード ----------
export const MIN_PLAYERS = 3; // 投票は自分以外の回答に入れるので、3人以上で遊べる
export const ROOM_CODE_LENGTH = 4; // 部屋コードの長さ

// ---------- 入力の上限（文字数）----------
export const MAX_NAME_LEN = 200; // 表示名
export const MAX_ANSWER_LEN = 100; // 回答
export const MAX_THEME_LEN = 40; // 題材

// ---------- 回答の制限時間（秒）。0 は制限なし ----------
export const TIME_LIMIT_MIN = 5;
export const TIME_LIMIT_MAX = 180;

// ---------- 反応マークの種類（いいね・バッド・応援・笑い）----------
export const REACTIONS = Object.freeze(['like', 'bad', 'cheer', 'laugh']);

// ---------- 部屋設定の選択肢と、既定値 ----------
export const PRESENTER_MODE = Object.freeze({
  HOST: 'host', // 毎ラウンド、主催者に戻す
  ROTATION: 'rotation', // 順番に回す
});
export const IDENTITY_MODE = Object.freeze({
  NAMED: 'named', // 記名
  ANONYMOUS: 'anonymous', // 匿名
});
export const CHOOSER_MODE = Object.freeze({
  ALL: 'all', // 全員の投票で、正解を決める
  ONE: 'one', // 一人が、正解を決める
});
export const DEFAULT_SETTINGS = Object.freeze({
  presenterMode: PRESENTER_MODE.HOST,
  identityMode: IDENTITY_MODE.NAMED,
  chooserMode: CHOOSER_MODE.ALL,
  timeLimit: 0, // 回答の制限時間（秒）。0 は制限なし
});
