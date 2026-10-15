// サーバーと画面が、WebSocket でやりとりするメッセージの種類（t）と、画面がエラーのコードを見て動きを変えるもの。
// 値は、そのまま通信に載っているので、変えてはいけない。

export const MSG = Object.freeze({
  // 画面 → サーバー
  CREATE: 'create', // 部屋をつくる
  JOIN: 'join', // 部屋に入る
  ACT: 'act', // 部屋の中の操作（a に操作の名前を付ける）

  // サーバー → 画面
  HELLO: 'hello', // つないだとき。配信中の版を知らせる
  JOINED: 'joined', // 入室できた
  STATE: 'state', // その人用のビュー
  NOTICE: 'notice', // 全員への通知
  REACT: 'react', // 反応マーク
  ERROR: 'error', // 操作のエラー
  NEED_CONFIRM: 'needConfirm', // 未完了の人がいるので、確認が要る
  REMOVED: 'removed', // 部屋から外された
  CLOSED: 'closed', // 部屋が閉じられた
  LEFT: 'left', // 退出した
});

// 画面が、エラーのコードを見て、動きを変えるもの（ほかのエラーコードは、サーバーの中だけで使う）
export const ERR = Object.freeze({
  NO_ROOM: 'no_room', // 部屋が見つからない
  BANNED: 'banned', // 部屋から外されていて、入れない
});
