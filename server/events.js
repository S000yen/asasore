// 部屋で起きたイベントの種別。room.js が操作の結果として返し、messages.js が通知文にする。
// 値は文字列のまま（テストや記録で読みやすいように）。新しい種別を足したら、messages.js の NOTICES にも、通知の有無を書くこと。

export const EVENT = Object.freeze({
  RENAMED: 'renamed',
  HOST_TRANSFERRED: 'host_transferred',
  PLAYER_REMOVED: 'player_removed',
  PLAYER_ALLOWED: 'player_allowed',
  SETTINGS_CHANGED: 'settings_changed',
  ROUND_STARTED: 'round_started',
  PRESENTER_CHANGED: 'presenter_changed',
  PRESENTER_RETURNED_TO_HOST: 'presenter_returned_to_host',
  TOPIC_DRAFT: 'topic_draft',
  TOPIC_CONFIRMED: 'topic_confirmed',
  TOPIC_REPORTED: 'topic_reported',
  SPECTATOR_PENDING: 'spectator_pending',
  SPECTATOR_CHANGED: 'spectator_changed',
  ROOM_RESET: 'room_reset',
  ROOM_CLOSED: 'room_closed',
  REACT: 'react',
  CHOOSER_CHANGED: 'chooser_changed',
  CHOOSER_RETURNED_TO_HOST: 'chooser_returned_to_host',
  ROLE_RECLAIMED: 'role_reclaimed',
  TIME_UP: 'time_up',
});
