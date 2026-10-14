// 部屋ひとつ分の状態とフェーズ遷移。通信は持たない（index.js が受け持つ）。
//
// フェーズ: lobby → topic → answer → reveal → vote → result → (次ラウンドの topic)
//
// 匿名モードの作者情報は ownerId としてこの中にだけ置き、viewFor() では
// 結果発表まで他人に渡さない。削除された人の情報も部屋が閉じるまでここに残す。

import { randomUUID, randomInt } from 'node:crypto';
import {
  RoomError,
  activePlayers,
  connectedPlayers,
  connectedGamePlayers,
  gamePlayers,
  getActive,
  getPlayer,
  requireHost,
  requirePresenter,
  canAssignPresenter,
  canAssignChooser,
  holderAvailable,
  pickSuccessor,
  pickNextInRotation,
  pickRandomPresenter,
  normalizeOrder,
} from './roles.js';

export const REACTIONS = ['like', 'bad', 'cheer', 'laugh']; // いいね・バッド・応援・笑い
const HIRAGANA = /^[\u3041-\u3093]$/;
const DEFAULT_GRACE_MS = 3 * 60 * 1000; // 主催者・出題者が落ちてから引き継ぐまで
const DEFAULT_EMPTY_CLOSE_MS = 30 * 60 * 1000; // 誰もいなくなってから部屋を閉じるまで
const MAX_ANSWER_LEN = 100;
const MAX_THEME_LEN = 40;
const MAX_NAME_LEN = 20;

function shuffle(list) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export const MIN_PLAYERS = 3; // 投票は自分以外の回答に入れるので、3人以上で遊べる

const TIME_LIMITS = [0, 30, 60, 90, 120];

export class Room {
  constructor(code, { graceMs = DEFAULT_GRACE_MS, emptyCloseMs = DEFAULT_EMPTY_CLOSE_MS, now = Date.now() } = {}) {
    this.code = code;
    this.createdAt = now;
    this.graceMs = graceMs;
    this.emptyCloseMs = emptyCloseMs;
    this.closed = false;

    this.players = new Map(); // id -> { id, name, seq, joinedAt, connected, disconnectedAt, removed }
    this.nextSeq = 0;
    this.hostId = null;
    this.presenterId = null;
    this.rotationCursor = null; // 順番方式で「予定どおりの」直前の出題者

    this.settings = {
      presenterMode: 'host', // 'host'（毎ラウンド主催者に戻す）| 'rotation'（順番に回す）
      identityMode: 'named', // 'named' | 'anonymous'
      chooserMode: 'all', // 正解を選ぶ人：'all'（全員の投票）| 'one'（一人が決める）
      timeLimit: 0, // 回答の制限時間（秒）。0 は制限なし
      order: [], // 順番方式の並び（デフォルトは参加順）
    };

    this.phase = 'lobby';
    this.bombed = false; // 制限時間切れで、未回答の人がいたまま進んだか
    this.round = 0;
    this.topic = null; // { hiragana, theme }
    this.topicConfirmed = false;
    this.answers = new Map(); // ownerId -> { id, ownerId, text, revealed, revealSeq }
    this.votes = new Map(); // voterId -> answerId
    this.chooserId = null; // chooserMode が 'one' のとき、正解を選ぶ人（投票フェーズの間だけ）
    this.choice = null; // その人が選んだ回答の id
    this.lastReactAt = new Map(); // 反応マークの連打対策（playerId -> 時刻）
    this.groups = []; // 主催者が「同じ回答」としてまとめたもの。回答の id の配列の配列（2つ以上）。投票・選択は、まとまりを1つとして数える
    this.revealCounter = 0;
    this.result = null;
    this.poolOrder = [];
    this.history = []; // 終わったラウンドの記録（削除された人の分も含む）
    this.usedThemes = new Set(); // この部屋で、確定して回した題材
    this.blockedThemes = new Set(); // この部屋で、「おかしい」と報告された題材
  }

  // ---------- 入室・退室 ----------

  // playerId が既知なら同じ参加者として復帰、なければ新規参加。最初の入室者が主催者になる。
  join(playerId, name, now = Date.now(), { spectator = false } = {}) {
    if (this.closed) throw new RoomError('closed', 'この部屋は閉じられています');
    const known = playerId ? this.players.get(playerId) : null;
    if (known) {
      if (known.removed) throw new RoomError('banned', 'この部屋には入れません');
      known.connected = true;
      known.disconnectedAt = null;
      return known;
    }
    // 名前が空なら「ユーザーN」。端末に残っていた名前が他の人と重なったら、末尾に番号を付ける。
    const wanted = String(name ?? '').trim().slice(0, MAX_NAME_LEN);
    const p = {
      id: randomUUID(),
      name: wanted ? this._dedupeName(wanted) : this._defaultName(),
      seq: this.nextSeq++,
      joinedAt: now,
      connected: true,
      disconnectedAt: null,
      removed: false,
      spectator: Boolean(spectator) && Boolean(this.hostId), // 観戦で入れる（最初の人は主催者なので、必ず参戦）
      nextSpectator: null, // ラウンドの途中で切り替えを頼んだとき、次のラウンドから変わる先
    };
    this.players.set(p.id, p);
    this.settings.order.push(p.id);
    if (!this.hostId) {
      this.hostId = p.id;
      this.presenterId = p.id;
    }
    return p;
  }

  // 使われていない最小の番号で「ユーザーN」を作る（削除された人の名前とも重ならないようにする）
  _defaultName() {
    const used = new Set([...this.players.values()].map((p) => p.name));
    for (let n = 1; ; n++) {
      if (!used.has(`ユーザー${n}`)) return `ユーザー${n}`;
    }
  }

  _dedupeName(wanted, exceptId) {
    const used = new Set([...this.players.values()].filter((p) => p.id !== exceptId).map((p) => p.name));
    if (!used.has(wanted)) return wanted;
    for (let n = 2; ; n++) {
      const suffix = String(n);
      const cand = wanted.slice(0, MAX_NAME_LEN - suffix.length) + suffix;
      if (!used.has(cand)) return cand;
    }
  }

  // 表示名の変更。参加中の人なら、いつでも自分の名前を変えられる。
  rename(by, name) {
    const p = getActive(this, by);
    const clean = String(name ?? '').trim();
    if (!clean) throw new RoomError('bad_name', '表示名を入力してください');
    if (clean.length > MAX_NAME_LEN) throw new RoomError('bad_name', `表示名は${MAX_NAME_LEN}文字までです`);
    const taken = [...this.players.values()].some((q) => q.id !== by && !q.removed && q.name === clean);
    if (taken) throw new RoomError('name_taken', 'その名前はすでに使われています');
    p.name = clean;
    return { type: 'renamed', id: by };
  }

  disconnect(playerId, now = Date.now()) {
    const p = this.players.get(playerId);
    if (!p) return;
    p.connected = false;
    p.disconnectedAt = now;
  }

  // 定期的に呼ぶ。猶予を過ぎた主催者・出題者の引き継ぎと、空き部屋の終了判定をする。
  tick(now = Date.now()) {
    const events = [];
    const host = this.players.get(this.hostId);
    if (host && !host.connected && now - host.disconnectedAt >= this.graceMs) {
      const next = pickSuccessor(this, host.id);
      if (next) events.push(this._setHost(next.id, 'auto'));
    }
    if (this.phase === 'answer' && this.settings.timeLimit > 0 && this.answerStartedAt && now - this.answerStartedAt >= this.settings.timeLimit * 1000) {
      events.push(this._timeUp());
    }
    if (this.phase === 'topic') {
      const pres = this.players.get(this.presenterId);
      const hostNow = this.players.get(this.hostId);
      if (pres && !pres.connected && now - pres.disconnectedAt >= this.graceMs && hostNow?.connected) {
        this.presenterId = this.hostId;
        this.topic = null;
        events.push({ type: 'presenter_returned_to_host', from: pres.id, to: this.hostId });
      }
    }
    if (this.phase === 'vote' && this.settings.chooserMode === 'one') {
      const ch = this.players.get(this.chooserId);
      const hostNow = this.players.get(this.hostId);
      if (ch && !ch.connected && now - ch.disconnectedAt >= this.graceMs && hostNow?.connected) {
        this.chooserId = this.hostId;
        if (this.choice && this._selfOnly(this.hostId, this.choice)) this.choice = null;
        events.push({ type: 'chooser_returned_to_host', from: ch.id, to: this.hostId });
      }
    }
    if (this.shouldClose(now)) {
      this.close();
      events.push({ type: 'room_closed', reason: 'empty' });
    }
    return events;
  }

  shouldClose(now = Date.now()) {
    if (this.closed) return false;
    if (connectedPlayers(this).length > 0) return false;
    const last = Math.max(this.createdAt, ...[...this.players.values()].map((p) => p.disconnectedAt ?? 0));
    return now - last >= this.emptyCloseMs;
  }

  // 部屋を閉じる。内部に残していた記録もここで破棄する。
  close(by) {
    if (by !== undefined) requireHost(this, by);
    this.closed = true;
    this.players.clear();
    this.answers.clear();
    this.votes.clear();
    this.history = [];
    this.usedThemes.clear();
    this.blockedThemes.clear();
    this.result = null;
    this.hostId = null;
    this.presenterId = null;
  }

  // ---------- 主催者まわり ----------

  _setHost(newId, how) {
    const from = this.hostId;
    if (this.presenterId === from) this.presenterId = newId; // 出題者を兼ねていたら権限も移る
    if (this.chooserId === from) this.chooserId = newId; // 正解を選ぶ人を兼ねていたら、それも移る
    this.hostId = newId;
    const np = this.players.get(newId);
    if (np) { np.spectator = false; np.nextSpectator = null; } // 主催者は、必ず参戦
    return { type: 'host_transferred', from, to: newId, how };
  }

  transferHost(by, to) {
    requireHost(this, by);
    const target = getActive(this, to);
    if (to === by) throw new RoomError('bad_target', '自分自身には譲渡できません');
    if (!target.connected) throw new RoomError('not_connected', '接続中の人にだけ譲渡できます');
    return this._setHost(to, 'manual');
  }

  // 削除は「削除済み」の印を付けるだけで、回答や投票のデータは残す。
  removePlayer(by, target) {
    requireHost(this, by);
    if (target === by) throw new RoomError('bad_target', '自分自身は削除できません');
    const p = getActive(this, target);
    p.removed = true;
    if (this.chooserId === target) { this.chooserId = this.hostId; if (this.choice && this._selfOnly(this.hostId, this.choice)) this.choice = null; }
    if (this.presenterId === target) {
      this.presenterId = this.hostId;
      this.topic = null;
    }
    return { type: 'player_removed', id: target };
  }

  // 再入室を許可する。以前の回答・投票はそのまま戻る。
  allowRejoin(by, target) {
    requireHost(this, by);
    const p = this.players.get(target);
    if (!p) throw new RoomError('no_such_player', '参加者が見つかりません');
    p.removed = false;
    return { type: 'player_allowed', id: target };
  }

  // 部屋設定。ラウンドの途中では変えられない。
  setSettings(by, patch = {}) {
    requireHost(this, by);
    if (this.phase !== 'lobby' && this.phase !== 'result') {
      throw new RoomError('bad_phase', 'ラウンドの途中では部屋設定を変えられません');
    }
    if (patch.presenterMode !== undefined) {
      if (!['host', 'rotation'].includes(patch.presenterMode)) throw new RoomError('bad_setting', '出題者方式が正しくありません');
      this.settings.presenterMode = patch.presenterMode;
    }
    if (patch.identityMode !== undefined) {
      if (!['named', 'anonymous'].includes(patch.identityMode)) throw new RoomError('bad_setting', '記名／匿名の指定が正しくありません');
      this.settings.identityMode = patch.identityMode;
    }
    if (patch.chooserMode !== undefined) {
      if (!['all', 'one'].includes(patch.chooserMode)) throw new RoomError('bad_setting', '正解を選ぶ人の指定が正しくありません');
      this.settings.chooserMode = patch.chooserMode;
    }
    if (patch.timeLimit !== undefined) {
      const n = Number(patch.timeLimit);
      if (!TIME_LIMITS.includes(n)) throw new RoomError('bad_setting', '制限時間の指定が正しくありません');
      this.settings.timeLimit = n;
    }
    if (patch.order !== undefined) {
      this.settings.order = normalizeOrder(this, patch.order);
    }
    return { type: 'settings_changed' };
  }

  // ---------- ラウンド進行 ----------

  _need(...phases) {
    if (!phases.includes(this.phase)) throw new RoomError('bad_phase', `いまはその操作ができません（${this.phase}）`);
  }

  _archiveRound() {
    if (this.round === 0) return;
    this.history.push({
      round: this.round,
      topic: this.topic,
      answers: [...this.answers.values()].map((a) => ({ ...a })),
      votes: [...this.votes.entries()],
      result: this.result,
    });
  }

  startRound(by) {
    requireHost(this, by);
    this._need('lobby', 'result');
    const playing = connectedPlayers(this).filter((p) => !(p.nextSpectator ?? p.spectator)).length; // 次のラウンドから参戦する人の数
    if (playing < MIN_PLAYERS) throw new RoomError('min_players', `${MIN_PLAYERS}人以上いないと始められません（投票で、自分以外の回答を選ぶため）`);
    for (const p of this.players.values()) if (p.nextSpectator !== null && p.nextSpectator !== undefined) { p.spectator = p.nextSpectator; p.nextSpectator = null; }
    this._archiveRound();
    this.round += 1;
    this.answers.clear();
    this.votes.clear();
    this.groups = [];
    this.choice = null; // 選ぶ人（chooserId）は、次のラウンドにも引き継ぐ
    this.revealCounter = 0;
    this.result = null;
    this.bombed = false;
    this.topic = null;
    this.topicConfirmed = false;

    if (this.settings.presenterMode === 'rotation') {
      const next = pickNextInRotation(this);
      this.presenterId = next ? next.id : this.hostId;
      if (next) this.rotationCursor = next.id;
    } else {
      // 前の出題者がまだいるなら、そのまま引き継ぐ（いなければ主催者）
      this.presenterId = holderAvailable(this, this.presenterId) ? this.presenterId : this.hostId;
    }
    this.phase = 'topic';
    return { type: 'round_started', round: this.round, presenterId: this.presenterId };
  }

  // 出題者の指名（主催者はいつでも、出題者は委譲として）。指名されると下書きは白紙に戻る。
  setPresenter(by, to) {
    getActive(this, by);
    if (!canAssignPresenter(this, by)) throw new RoomError('not_allowed', '出題者を指名できるのは、いまの出題者です（不在のときは主催者）');
    this._need('topic');
    const target = getActive(this, to); // 観戦中の人にも任せられる
    if (!target.connected) throw new RoomError('not_connected', '接続中の人にだけ任せられます');
    this.presenterId = to;
    this.topic = null;
    return { type: 'presenter_changed', by, to };
  }

  randomPresenter(by) {
    getActive(this, by);
    if (!canAssignPresenter(this, by)) throw new RoomError('not_allowed', '出題者を指名できるのは、いまの出題者です（不在のときは主催者）');
    this._need('topic');
    const pick = pickRandomPresenter(this); // 本人も含めて選ぶ
    if (!pick) throw new RoomError('no_candidate', '指名できる人がいません');
    return this.setPresenter(by, pick.id);
  }

  // ひらがなと題材（カテゴリと尺度を1セットにしたもの）。確定するまで何度でも変えられる。
  setTopic(by, { hiragana, theme } = {}) {
    requirePresenter(this, by);
    this._need('topic');
    const h = String(hiragana ?? '').trim();
    const t = String(theme ?? '').trim();
    if (!HIRAGANA.test(h)) throw new RoomError('bad_topic', 'ひらがな1文字を指定してください');
    if (!t || t.length > MAX_THEME_LEN) throw new RoomError('bad_topic', `題材は1〜${MAX_THEME_LEN}文字で入力してください`);
    this.topic = { hiragana: h, theme: t };
    return { type: 'topic_draft' };
  }

  confirmTopic(by) {
    requirePresenter(this, by);
    this._need('topic');
    if (!this.topic) throw new RoomError('bad_topic', 'お題がまだ決まっていません');
    this.topicConfirmed = true;
    this.usedThemes.add(this.topic.theme); // この部屋では、同じ題材をランダムで出さない
    this.phase = 'answer';
    this.answerStartedAt = Date.now();
    return { type: 'topic_confirmed', topic: this.topic };
  }

  // 「おかしいお題」の報告。この部屋では、その題材を二度とランダムで出さない。
  // 全体の出現率を下げる処理は、お題プール（topics.js）が受け持つ。
  reportTopic(by, theme) {
    requirePresenter(this, by);
    this._need('topic');
    if (!this.topic || this.topic.theme !== theme) throw new RoomError('bad_topic', 'お題が変わりました。もう一度、確かめてください');
    this.blockedThemes.add(theme);
    return { type: 'topic_reported', theme };
  }

  // ランダムで引くときに除く題材（お題プールに渡す）
  drawFilter() {
    return { used: this.usedThemes, blocked: this.blockedThemes };
  }

  submitAnswer(by, text) {
    getPlayer(this, by);
    this._need('answer');
    const t = String(text ?? '').trim();
    if (!t || t.length > MAX_ANSWER_LEN) throw new RoomError('bad_answer', `回答は1〜${MAX_ANSWER_LEN}文字で入力してください`);
    if (this.answers.has(by)) throw new RoomError('already_answered', '回答済みです。書き換えるには、先に取り下げてください');
    this.answers.set(by, { id: randomUUID(), ownerId: by, text: t, revealed: false, revealSeq: 0 });
  }

  withdrawAnswer(by) {
    getPlayer(this, by);
    this._need('answer', 'reveal');
    this.answers.delete(by);
  }

  // 削除済みの人の回答は、見た目・集計から外す（データは残す）。
  _visibleAnswers() {
    return [...this.answers.values()].filter((a) => this.players.get(a.ownerId) && !this.players.get(a.ownerId).removed);
  }

  _findAnswer(answerId) {
    return this._visibleAnswers().find((a) => a.id === answerId) ?? null;
  }

  _reveal(a) {
    if (!a.revealed) {
      a.revealed = true;
      a.revealSeq = ++this.revealCounter;
    }
  }

  // 記名モード：自分の回答を自分で開示する。
  revealOwn(by) {
    getActive(this, by);
    this._need('reveal');
    if (this.settings.identityMode !== 'named') throw new RoomError('wrong_mode', '匿名モードでは各自で開示できません');
    const a = this.answers.get(by);
    if (!a) throw new RoomError('no_answer', '回答がありません');
    this._reveal(a);
  }

  // 匿名モード：主催者が内容を見て1つずつ開示する。
  revealSelected(by, answerId) {
    requireHost(this, by);
    this._need('reveal');
    if (this.settings.identityMode !== 'anonymous') throw new RoomError('wrong_mode', '記名モードでは選択開示を使いません');
    const a = this._findAnswer(answerId);
    if (!a) throw new RoomError('no_answer', '回答が見つかりません');
    this._reveal(a);
  }

  // 主催者が残りを全員分まとめて開示する（記名・匿名の両方）。
  revealAll(by) {
    requireHost(this, by);
    this._need('reveal');
    const rest = this._visibleAnswers().filter((a) => !a.revealed);
    const ordered =
      this.settings.identityMode === 'anonymous'
        ? shuffle(rest)
        : rest.sort((a, b) => this.players.get(a.ownerId).seq - this.players.get(b.ownerId).seq);
    for (const a of ordered) this._reveal(a);
  }

  // ---------- 観戦／参戦 ----------

  // 観戦と参戦を切り替える。回答中までは、すぐ変わる。投票より先（開示・投票）では、次のラウンドから変わる。
  // ロビーと結果発表のあいだは、ラウンドが動いていないので、すぐ変わる。
  setSpectator(by, spectator) {
    const p = getActive(this, by);
    const want = Boolean(spectator);
    const now = ['lobby', 'topic', 'answer', 'result'].includes(this.phase);
    if (!now) {
      p.nextSpectator = want === Boolean(p.spectator) ? null : want; // 現在と同じなら、取り消し
      return { type: 'spectator_pending', id: by, spectator: want };
    }
    if (want === Boolean(p.spectator)) { p.nextSpectator = null; return null; }
    if (want) {
      if (this.phase === 'answer') this.answers.delete(by); // 回答済みなら、取り下げる
    }
    p.spectator = want;
    p.nextSpectator = null;
    return { type: 'spectator_changed', id: by, spectator: want };
  }

  // 部屋のリセット：記録・問題数・使った題材を消して、ロビーに戻る。参加者と設定は、そのまま。
  resetRoom(by) {
    requireHost(this, by);
    this.history = [];
    this.round = 0;
    this.usedThemes.clear();
    this.answers.clear();
    this.votes.clear();
    this.groups = [];
    this.choice = null;
    this.result = null;
    this.bombed = false;
    this.topic = null;
    this.topicConfirmed = false;
    this.poolOrder = [];
    this.revealCounter = 0;
    this.rotationCursor = null;
    this.chooserId = null;
    this.presenterId = this.hostId;
    for (const p of this.players.values()) if (p.nextSpectator !== null && p.nextSpectator !== undefined) { p.spectator = p.nextSpectator; p.nextSpectator = null; }
    this.phase = 'lobby';
    return { type: 'room_reset' };
  }

  // ---------- 反応マーク（開示中だけ。状態は変えず、全員に流すだけ） ----------

  // 連打しすぎないよう、1人あたり0.12秒に1回まで。種類は決まったものだけ。
  react(by, kind) {
    getActive(this, by);
    this._need('reveal');
    if (!REACTIONS.includes(kind)) throw new RoomError('bad_reaction', 'その反応は使えません');
    const now = Date.now();
    if (now - (this.lastReactAt.get(by) ?? 0) < 120) return null;
    this.lastReactAt.set(by, now);
    return { type: 'react', kind };
  }

  // ---------- 同じ回答のグループ化 ----------

  // いま有効なまとまり：開示済みで、削除されていない回答だけ。2つ未満になったものは無いことにする。
  _liveGroups() {
    const ok = new Set(this._visibleAnswers().filter((a) => a.revealed).map((a) => a.id));
    return this.groups.map((g) => g.filter((id) => ok.has(id))).filter((g) => g.length >= 2);
  }

  // 回答 id が属するまとまり（なければその1つだけ）
  _unitOf(answerId) {
    return this._liveGroups().find((g) => g.includes(answerId)) ?? [answerId];
  }

  // 自分だけの回答（まとまりに入っていない）には、投票・選択できない。まとまりに入っていれば、同じ回答の人も、そのまとまりに投票できる（集計で合わせる）。
  _selfOnly(by, answerId) {
    const a = this._findAnswer(answerId);
    return Boolean(a) && a.ownerId === by && this._unitOf(answerId).length === 1;
  }

  _ownersOf(ids) {
    return new Set(ids.map((id) => this._findAnswer(id)?.ownerId).filter(Boolean));
  }

  // 主催者が、開示済みの回答を1つにまとめる（すでにまとまっているものが混じれば、合わせて1つにする）
  group(by, answerIds) {
    requireHost(this, by);
    this._need('reveal', 'vote');
    const ids = [...new Set(answerIds ?? [])];
    if (ids.length < 2) throw new RoomError('few', 'まとめるには、2つ以上選んでください');
    for (const id of ids) {
      const a = this._findAnswer(id);
      if (!a || !a.revealed) throw new RoomError('no_answer', 'まとめられる回答が見つかりません（開示済みのものだけです）');
    }
    const live = this._liveGroups();
    const merged = new Set(ids);
    for (const g of live) if (g.some((id) => merged.has(id))) g.forEach((id) => merged.add(id));
    const next = live.filter((g) => !g.some((id) => merged.has(id)));
    next.push([...merged]);
    this.groups = next;
  }

  // 選んだ回答を、まとまりから外す（残りが1つになったまとまりは解消）
  ungroup(by, answerIds) {
    requireHost(this, by);
    this._need('reveal', 'vote');
    const drop = new Set(answerIds ?? []);
    this.groups = this._liveGroups().map((g) => g.filter((id) => !drop.has(id))).filter((g) => g.length >= 2);
    // ばらした結果、自分だけの回答への票になってしまったものは取り消す
    for (const [voter, aid] of [...this.votes]) if (this._selfOnly(voter, aid)) this.votes.delete(voter);
    if (this.choice && this._selfOnly(this.chooserId, this.choice)) this.choice = null;
  }

  vote(by, answerId) {
    getPlayer(this, by);
    this._need('vote');
    if (this.settings.chooserMode !== 'all') throw new RoomError('wrong_mode', 'このモードでは投票ではなく、選ぶ人が決めます');
    const a = this._findAnswer(answerId);
    if (!a || !a.revealed) throw new RoomError('no_answer', '投票できる回答が見つかりません');
    if (this._selfOnly(by, answerId)) throw new RoomError('self_vote', '自分の回答には投票できません');
    this.votes.set(by, answerId);
  }

  // 「一人が決める」モード：選ぶ人が正解を選ぶ（結果を出すまで、何度でも選び直せる）
  choose(by, answerId) {
    getActive(this, by); // 観戦中の人も、選ぶ人になれる
    this._need('vote');
    if (this.settings.chooserMode !== 'one') throw new RoomError('wrong_mode', 'このモードでは、全員の投票で決めます');
    if (by !== this.chooserId) throw new RoomError('not_allowed', '正解を選べるのは、選ぶ人だけです');
    const a = this._findAnswer(answerId);
    if (!a || !a.revealed) throw new RoomError('no_answer', '選べる回答が見つかりません');
    if (this._selfOnly(by, answerId)) throw new RoomError('self_vote', '自分の回答は選べません');
    this.choice = answerId;
  }

  // 選ぶ人を、ほかの人に任せる（主催者か、いまの選ぶ人）
  setChooser(by, to) {
    getActive(this, by);
    this._need('vote');
    if (this.settings.chooserMode !== 'one') throw new RoomError('wrong_mode', 'このモードでは、選ぶ人はいません');
    if (!canAssignChooser(this, by)) throw new RoomError('not_allowed', '選ぶ人を任せられるのは、いまの選ぶ人です（不在のときは主催者）');
    const target = getActive(this, to); // 観戦中の人にも任せられる
    if (!target.connected) throw new RoomError('not_connected', '接続中の人にだけ任せられます');
    this.chooserId = to;
    if (this.choice && this._selfOnly(to, this.choice)) this.choice = null; // 自分の回答は選べない
    return { type: 'chooser_changed', by, to };
  }

  // 主催者による強制回収：出題者（題決めの間）か、選ぶ人（投票の間）を、主催者に戻す。
  reclaimRole(by) {
    requireHost(this, by);
    if (this.phase === 'topic' && this.presenterId !== this.hostId) {
      const from = this.presenterId;
      this.presenterId = this.hostId;
      this.topic = null;
      return { type: 'role_reclaimed', role: 'presenter', from, to: this.hostId };
    }
    if (this.phase === 'vote' && this.settings.chooserMode === 'one' && this.chooserId !== this.hostId) {
      const from = this.chooserId;
      this.chooserId = this.hostId;
      if (this.choice && this._selfOnly(this.hostId, this.choice)) this.choice = null;
      return { type: 'role_reclaimed', role: 'chooser', from, to: this.hostId };
    }
    throw new RoomError('nothing_to_reclaim', '回収できる役割がありません');
  }

  randomChooser(by) {
    getActive(this, by);
    this._need('vote');
    const pick = pickRandomPresenter(this); // 本人も含めて選ぶ
    if (!pick) throw new RoomError('no_candidate', '指名できる人がいません');
    return this.setChooser(by, pick.id);
  }

  // 未回答・未開示・未投票の確認。匿名の漏れを避けるため、開示フェーズでは件数だけ返す。
  _pending() {
    if (this.phase === 'answer') {
      const names = gamePlayers(this).filter((p) => !this.answers.has(p.id)).map((p) => p.name);
      return { count: names.length, names };
    }
    if (this.phase === 'reveal') {
      const count = this._visibleAnswers().filter((a) => !a.revealed).length;
      return { count, names: null };
    }
    if (this.phase === 'vote') {
      if (this.settings.chooserMode === 'one') {
        const c = this.players.get(this.chooserId);
        return this.choice ? { count: 0, names: [] } : { count: 1, names: [c?.name ?? ''] };
      }
      const shown = this._visibleAnswers().filter((a) => a.revealed);
      const names = connectedGamePlayers(this)
        .filter((p) => !this.votes.has(p.id) && shown.some((a) => !this._selfOnly(p.id, a.id)))
        .map((p) => p.name);
      return { count: names.length, names };
    }
    return { count: 0, names: [] };
  }

  // 主催者が次へ進む。未完了の人がいると、force でない限り確認を返して止まる。
  advance(by, { force = false } = {}) {
    if (this.phase === 'vote' && this.settings.chooserMode === 'one') {
      // 「一人が決める」モードで結果へ進めるのは、選ぶ人だけ（主催者には出さない）
      getActive(this, by);
      if (by !== this.chooserId) throw new RoomError('not_allowed', '結果へ進めるのは、正解を選ぶ人です');
    } else {
      requireHost(this, by);
    }
    if (this.phase === 'lobby' || this.phase === 'result') {
      this.startRound(by);
      return { needConfirm: false, pending: { count: 0, names: [] }, phase: this.phase };
    }
    if (this.phase === 'topic') {
      throw new RoomError('topic_not_confirmed', 'お題がまだ確定していません（出題者が確定するか、出題者を指名し直してください）');
    }
    const pending = this._pending();
    if (this.phase === 'vote' && this.settings.chooserMode === 'one' && pending.count > 0) throw new RoomError('votes_pending', '正解がまだ選ばれていません');
    if (pending.count > 0 && !force) return { needConfirm: true, pending, phase: this.phase };

    if (this.phase === 'answer') {
      this._leaveAnswer();
    } else if (this.phase === 'reveal') {
      if (!this._visibleAnswers().some((a) => a.revealed)) throw new RoomError('no_revealed', '開示された回答がありません');
      this.phase = 'vote';
      this.choice = null;
      this.chooserId = this.settings.chooserMode === 'one' ? (holderAvailable(this, this.chooserId) ? this.chooserId : this.hostId) : null;
    } else if (this.phase === 'vote') {
      this._tally();
      this.phase = 'result';
    }
    return { needConfirm: false, pending: { count: 0, names: [] }, phase: this.phase };
  }

  // 回答フェーズを終える。回答が1つもなければ、全員不正解として結果へ（次のラウンドへ進める）。
  _leaveAnswer() {
    if (this._visibleAnswers().length === 0) {
      this.result = { tallies: [], winners: [], tie: false, mode: this.settings.chooserMode, total: 0, noAnswer: true };
      this.phase = 'result';
      return;
    }
    this.phase = 'reveal';
    this.poolOrder = shuffle(this._visibleAnswers().map((a) => a.id)); // 匿名の並びは、ここで一度だけランダムに決める（持ち主の順番が漏れない）
  }

  // 制限時間切れ：未回答の人がいれば爆弾が爆発し、そのまま開示へ進む。
  _timeUp() {
    const pending = this._pending();
    this.bombed = pending.count > 0;
    this._leaveAnswer();
    return { type: 'time_up', bomb: this.bombed, names: pending.names ?? [], noAnswer: Boolean(this.result?.noAnswer) };
  }

  // 多数決。同票なら同票の回答すべてを winners にする（tie: true）。
  _tally() {
    const shown = this._visibleAnswers().filter((a) => a.revealed);
    const groups = this._liveGroups();
    const groupNo = (id) => { const i = groups.findIndex((g) => g.includes(id)); return i < 0 ? null : i + 1; };
    const unitKey = (id) => { const i = groups.findIndex((g) => g.includes(id)); return i < 0 ? id : `g${i}`; };
    if (this.settings.chooserMode === 'one') {
      const win = this.choice ? new Set(this._unitOf(this.choice)) : new Set();
      const tallies = shown.map((a) => ({ answerId: a.id, ownerId: a.ownerId, votes: win.has(a.id) ? 1 : 0, group: groupNo(a.id) }));
      this.result = { tallies, winners: [...win], tie: false, mode: 'one', total: this.choice ? 1 : 0 };
      return;
    }
    const counts = new Map();
    let total = 0;
    for (const [voterId, answerId] of this.votes) {
      const voter = this.players.get(voterId);
      const a = this._findAnswer(answerId);
      if (!voter || voter.removed || !a || !a.revealed) continue;
      if (this._selfOnly(voterId, answerId)) continue;
      const k = unitKey(answerId);
      counts.set(k, (counts.get(k) ?? 0) + 1);
      total += 1;
    }
    const tallies = shown.map((a) => ({ answerId: a.id, ownerId: a.ownerId, votes: counts.get(unitKey(a.id)) ?? 0, group: groupNo(a.id) }));
    const max = Math.max(0, ...tallies.map((t) => t.votes));
    const winners = max > 0 ? tallies.filter((t) => t.votes === max).map((t) => t.answerId) : [];
    const winUnits = new Set(winners.map(unitKey));
    this.result = { tallies, winners, tie: winUnits.size > 1, total };
  }

  // プールの並び。匿名：開示の開始時に決めたランダムな順。記名：参加順。
  _poolSorted(list, anonymous) {
    if (anonymous) {
      const at = (a) => { const i = (this.poolOrder ?? []).indexOf(a.id); return i < 0 ? Infinity : i; };
      return [...list].sort((x, y) => at(x) - at(y) || (x.id < y.id ? -1 : 1));
    }
    return [...list].sort((x, y) => this.players.get(x.ownerId).seq - this.players.get(y.ownerId).seq);
  }

  // 結果が出たラウンドの記録（新しい順）。結果発表のあとなので、匿名モードでも作者を出してよい。
  _historyView() {
    const rounds = [...this.history];
    if (this.phase === 'result' && this.result) { // いまのラウンドは、まだ保管前
      rounds.push({ round: this.round, topic: this.topic, answers: [...this.answers.values()], result: this.result });
    }
    return rounds
      .filter((h) => h.result && h.topic)
      .map((h) => {
        const byId = new Map(h.answers.map((a) => [a.id, a]));
        const winners = new Set(h.result.winners);
        return {
          round: h.round,
          topic: { hiragana: h.topic.hiragana, theme: h.topic.theme },
          mode: h.result.mode ?? 'all',
          total: h.result.total ?? 0,
          entries: h.result.tallies
            .map((t) => ({ text: byId.get(t.answerId)?.text ?? '', author: this.players.get(t.ownerId)?.name ?? '', votes: t.votes, won: winners.has(t.answerId), group: t.group ?? null }))
            .sort((a, b) => b.votes - a.votes),
        };
      })
      .reverse();
  }

  // ---------- 閲覧者ごとの画面用データ ----------

  // 匿名モードでは、結果発表までは作者（名前・ownerId）を他人に渡さない。
  viewFor(pid) {
    const me = this.players.get(pid);
    if (!me || me.removed) throw new RoomError('no_such_player', '参加者が見つかりません');
    const anonymous = this.settings.identityMode === 'anonymous';
    const isHost = pid === this.hostId;
    const showAuthor = !anonymous || this.phase === 'result';
    const nameOf = (id) => this.players.get(id).name;

    const view = {
      code: this.code,
      phase: this.phase,
      round: this.round,
      settings: { ...this.settings, order: [...this.settings.order] },
      hostId: this.hostId,
      presenterId: this.presenterId,
      chooserId: this.phase === 'vote' ? this.chooserId : null,
      me: { id: pid, name: me.name, isHost, spectator: Boolean(me.spectator), nextSpectator: me.nextSpectator ?? null, isPresenter: pid === this.presenterId, isChooser: this.phase === 'vote' && pid === this.chooserId, canAssignPresenter: this.phase === 'topic' && canAssignPresenter(this, pid), canAssignChooser: this.phase === 'vote' && canAssignChooser(this, pid), canReclaim: isHost && ((this.phase === 'topic' && this.presenterId !== this.hostId) || (this.phase === 'vote' && this.settings.chooserMode === 'one' && this.chooserId !== this.hostId)) },
      players: activePlayers(this).map((p) => ({
        id: p.id,
        name: p.name,
        connected: p.connected,
        isHost: p.id === this.hostId,
        isPresenter: p.id === this.presenterId,
        spectator: Boolean(p.spectator),
        answered: this.answers.has(p.id),
        voted: this.votes.has(p.id),
      })),
      // お題は確定するまで出題者本人にだけ見せる（決定してから全員で考える）
      topic: this.topicConfirmed || pid === this.presenterId ? this.topic : null,
      topicConfirmed: this.topicConfirmed,
      myAnswer: this.answers.get(pid)?.text ?? null,
      // 削除した人の一覧は主催者にだけ見せる（再入室の許可に使う）
      removed: isHost ? [...this.players.values()].filter((p) => p.removed).map((p) => ({ id: p.id, name: p.name })) : [],
      answers: [],
      unrevealed: [],
      unrevealedCount: 0,
      pool: [],
      myVote: null,
      result: null,
      history: this._historyView(),
    };

    if (['reveal', 'vote', 'result'].includes(this.phase)) {
      const visible = this._visibleAnswers();
      const groups = this._liveGroups();
      const groupNo = (id) => { const i = groups.findIndex((g) => g.includes(id)); return i < 0 ? null : i + 1; };
      const toView = (a) => ({
        answerId: a.id,
        text: a.text,
        mine: a.ownerId === pid,
        revealed: a.revealed,
        author: showAuthor ? nameOf(a.ownerId) : null,
      });
      view.answers = visible
        .filter((a) => a.revealed)
        .sort((a, b) => a.revealSeq - b.revealSeq)
        .map(toView);
      const hidden = visible.filter((a) => !a.revealed);
      view.unrevealedCount = hidden.length;
      // 全部の回答を、位置が変わらない並びで出す（未開示は中身なし＝黒マス）。匿名の間は、自分の未開示マスも印を付けない。
      view.pool = this._poolSorted(visible, anonymous).map((a) => ({
        answerId: a.id,
        revealed: a.revealed,
        text: a.revealed ? a.text : null,
        mine: a.ownerId === pid && (a.revealed || !anonymous),
        group: a.revealed ? groupNo(a.id) : null,
        author: anonymous ? null : nameOf(a.ownerId),
        canReveal: this.phase === 'reveal' && !a.revealed && (anonymous ? isHost : a.ownerId === pid),
        canVote: this.phase === 'vote' && a.revealed && !this._selfOnly(pid, a.id) && ((this.settings.chooserMode === 'all' && !me.spectator) || (this.settings.chooserMode === 'one' && pid === this.chooserId)),
        canGroup: isHost && a.revealed && (this.phase === 'reveal' || this.phase === 'vote'),
      }));
      if (this.phase === 'reveal') {
        // 未開示の回答は「黒塗りの枠」として全員に見せる。中身を見られるのは本人だけ（先頭に出す）。
        // 記名：本人が自分の枠をタップして開示する。他の人の枠は、名前だけ付けて黒塗り。
        // 匿名：主催者が、全部黒塗りのまま1枠ずつ開示する（主催者にも中身と持ち主は伏せる）。本人には、自分の分が先頭に見える。
        const byId = [...hidden].sort((a, b) => (a.id < b.id ? -1 : 1));
        if (anonymous && isHost) {
          view.unrevealed = byId.map((a) => ({ answerId: a.id, mine: false, text: null, author: null, canReveal: true }));
        } else {
          const mine = byId.filter((a) => a.ownerId === pid).map((a) => ({ answerId: a.id, mine: true, text: a.text, author: null, canReveal: !anonymous }));
          const others = byId.filter((a) => a.ownerId !== pid).map(() => ({ answerId: null, mine: false, text: null, author: null, canReveal: false }));
          if (!anonymous) byId.filter((a) => a.ownerId !== pid).forEach((a, i) => { others[i].author = nameOf(a.ownerId); });
          view.unrevealed = [...mine, ...others];
        }
      }
    }
    if (this.phase === 'answer' && this.answerStartedAt) view.answerSec = Math.max(0, Math.floor((Date.now() - this.answerStartedAt) / 1000)); // 回答待ちの経過時間（画面で秒を進める）
    view.bombed = this.bombed;
    if (this.phase === 'vote') view.pendingCount = this._pending().count;
    if (this.phase === 'vote') view.myVote = this.settings.chooserMode === 'one' ? this.choice : (this.votes.get(pid) ?? null);
    if (this.phase === 'result' && this.result) {
      view.result = {
        winners: [...this.result.winners],
        tie: this.result.tie,
        noAnswer: Boolean(this.result.noAnswer),
        mode: this.result.mode ?? 'all',
        tallies: this.result.tallies.map((t) => {
          const a = this._findAnswer(t.answerId);
          return { answerId: t.answerId, text: a?.text ?? '', votes: t.votes, author: nameOf(t.ownerId), group: t.group ?? null };
        }),
      };
    }
    return view;
  }
}
