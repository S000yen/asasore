// 部屋の進行のフェーズ。lobby → topic → answer → reveal → vote → result → (次のラウンドの topic)
// サーバー（server/）と画面（public/js/）の両方が、この定義を読む。
// 値は、そのまま通信（view.phase）に載っているので、変えてはいけない。

export const PHASE = Object.freeze({
  LOBBY: 'lobby',
  TOPIC: 'topic',
  ANSWER: 'answer',
  REVEAL: 'reveal',
  VOTE: 'vote',
  RESULT: 'result',
});

// ラウンドの合間：部屋設定を変えられ、ラウンドを始められる
export const BETWEEN_ROUNDS = Object.freeze([PHASE.LOBBY, PHASE.RESULT]);

// 観戦と参戦の切り替えが、すぐ効くフェーズ（これ以外の、開示と投票の間は、次のラウンドから）
export const SPECTATE_NOW_PHASES = Object.freeze([PHASE.LOBBY, PHASE.TOPIC, PHASE.ANSWER, PHASE.RESULT]);

// 回答の一覧が見えるフェーズ
export const ANSWERS_SHOWN_PHASES = Object.freeze([PHASE.REVEAL, PHASE.VOTE, PHASE.RESULT]);

// 主催者が、同じ回答をまとめたり、ばらしたりできるフェーズ
export const GROUPING_PHASES = Object.freeze([PHASE.REVEAL, PHASE.VOTE]);
