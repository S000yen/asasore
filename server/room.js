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
  getActive,
  requireHost,
  requirePresenter,
  canAssignPresenter,
  pickSuccessor,
  pickNextInRotation,
  pickRandomPresenter,
  normalizeOrder,
} from './roles.js';

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
      order: [], // 順番方式の並び（デフォルトは参加順）
    };

    this.phase = 'lobby';
    this.round = 0;
    this.topic = null; // { hiragana, theme }
    this.topicConfirmed = false;
    this.answers = new Map(); // ownerId -> { id, ownerId, text, revealed, revealSeq }
    this.votes = new Map(); // voterId -> answerId
    this.revealCounter = 0;
    this.result = null;
    this.history = []; // 終わったラウンドの記録（削除された人の分も含む）
  }

  // ---------- 入室・退室 ----------

  // playerId が既知なら同じ参加者として復帰、なければ新規参加。最初の入室者が主催者になる。
  join(playerId, name, now = Date.now()) {
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
    if (this.phase === 'topic') {
      const pres = this.players.get(this.presenterId);
      const hostNow = this.players.get(this.hostId);
      if (pres && !pres.connected && now - pres.disconnectedAt >= this.graceMs && hostNow?.connected) {
        this.presenterId = this.hostId;
        this.topic = null;
        events.push({ type: 'presenter_returned_to_host', from: pres.id, to: this.hostId });
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
    this.result = null;
    this.hostId = null;
    this.presenterId = null;
  }

  // ---------- 主催者まわり ----------

  _setHost(newId, how) {
    const from = this.hostId;
    if (this.presenterId === from) this.presenterId = newId; // 出題者を兼ねていたら権限も移る
    this.hostId = newId;
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
    if (connectedPlayers(this).length < 2) throw new RoomError('min_players', '2人以上いないと始められません');
    this._archiveRound();
    this.round += 1;
    this.answers.clear();
    this.votes.clear();
    this.revealCounter = 0;
    this.result = null;
    this.topic = null;
    this.topicConfirmed = false;

    if (this.settings.presenterMode === 'rotation') {
      const next = pickNextInRotation(this);
      this.presenterId = next ? next.id : this.hostId;
      if (next) this.rotationCursor = next.id;
    } else {
      this.presenterId = this.hostId; // 毎ラウンド主催者に戻す
    }
    this.phase = 'topic';
    return { type: 'round_started', round: this.round, presenterId: this.presenterId };
  }

  // 出題者の指名（主催者はいつでも、出題者は委譲として）。指名されると下書きは白紙に戻る。
  setPresenter(by, to) {
    getActive(this, by);
    if (!canAssignPresenter(this, by)) throw new RoomError('not_allowed', '出題者を指名できるのは主催者か出題者です');
    this._need('topic');
    const target = getActive(this, to);
    if (!target.connected) throw new RoomError('not_connected', '接続中の人にだけ任せられます');
    this.presenterId = to;
    this.topic = null;
    return { type: 'presenter_changed', by, to };
  }

  randomPresenter(by) {
    requireHost(this, by);
    this._need('topic');
    const pick = pickRandomPresenter(this, this.presenterId);
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
    this.phase = 'answer';
    return { type: 'topic_confirmed', topic: this.topic };
  }

  submitAnswer(by, text) {
    getActive(this, by);
    this._need('answer');
    const t = String(text ?? '').trim();
    if (!t || t.length > MAX_ANSWER_LEN) throw new RoomError('bad_answer', `回答は1〜${MAX_ANSWER_LEN}文字で入力してください`);
    const existing = this.answers.get(by);
    if (existing) {
      existing.text = t;
    } else {
      this.answers.set(by, { id: randomUUID(), ownerId: by, text: t, revealed: false, revealSeq: 0 });
    }
  }

  withdrawAnswer(by) {
    getActive(this, by);
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

  vote(by, answerId) {
    getActive(this, by);
    this._need('vote');
    const a = this._findAnswer(answerId);
    if (!a || !a.revealed) throw new RoomError('no_answer', '投票できる回答が見つかりません');
    if (a.ownerId === by) throw new RoomError('self_vote', '自分の回答には投票できません');
    this.votes.set(by, answerId);
  }

  // 未回答・未開示・未投票の確認。匿名の漏れを避けるため、開示フェーズでは件数だけ返す。
  _pending() {
    if (this.phase === 'answer') {
      const names = activePlayers(this).filter((p) => !this.answers.has(p.id)).map((p) => p.name);
      return { count: names.length, names };
    }
    if (this.phase === 'reveal') {
      const count = this._visibleAnswers().filter((a) => !a.revealed).length;
      return { count, names: null };
    }
    if (this.phase === 'vote') {
      const shown = this._visibleAnswers().filter((a) => a.revealed);
      const names = connectedPlayers(this)
        .filter((p) => !this.votes.has(p.id) && shown.some((a) => a.ownerId !== p.id))
        .map((p) => p.name);
      return { count: names.length, names };
    }
    return { count: 0, names: [] };
  }

  // 主催者が次へ進む。未完了の人がいると、force でない限り確認を返して止まる。
  advance(by, { force = false } = {}) {
    requireHost(this, by);
    if (this.phase === 'lobby' || this.phase === 'result') {
      this.startRound(by);
      return { needConfirm: false, pending: { count: 0, names: [] }, phase: this.phase };
    }
    if (this.phase === 'topic') {
      throw new RoomError('topic_not_confirmed', 'お題がまだ確定していません（出題者が確定するか、出題者を指名し直してください）');
    }
    const pending = this._pending();
    if (pending.count > 0 && !force) return { needConfirm: true, pending, phase: this.phase };

    if (this.phase === 'answer') {
      if (this._visibleAnswers().length === 0) throw new RoomError('no_answers', '回答が1つもありません');
      this.phase = 'reveal';
    } else if (this.phase === 'reveal') {
      if (!this._visibleAnswers().some((a) => a.revealed)) throw new RoomError('no_revealed', '開示された回答がありません');
      this.phase = 'vote';
    } else if (this.phase === 'vote') {
      this._tally();
      this.phase = 'result';
    }
    return { needConfirm: false, pending: { count: 0, names: [] }, phase: this.phase };
  }

  // 多数決。同票なら同票の回答すべてを winners にする（tie: true）。
  _tally() {
    const counts = new Map();
    for (const [voterId, answerId] of this.votes) {
      const voter = this.players.get(voterId);
      const a = this._findAnswer(answerId);
      if (!voter || voter.removed || !a || !a.revealed) continue;
      counts.set(answerId, (counts.get(answerId) ?? 0) + 1);
    }
    const tallies = this._visibleAnswers()
      .filter((a) => a.revealed)
      .map((a) => ({ answerId: a.id, ownerId: a.ownerId, votes: counts.get(a.id) ?? 0 }));
    const max = Math.max(0, ...tallies.map((t) => t.votes));
    const winners = max > 0 ? tallies.filter((t) => t.votes === max).map((t) => t.answerId) : [];
    this.result = { tallies, winners, tie: winners.length > 1 };
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
      me: { id: pid, name: me.name, isHost, isPresenter: pid === this.presenterId },
      players: activePlayers(this).map((p) => ({
        id: p.id,
        name: p.name,
        connected: p.connected,
        isHost: p.id === this.hostId,
        isPresenter: p.id === this.presenterId,
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
      myVote: null,
      result: null,
    };

    if (['reveal', 'vote', 'result'].includes(this.phase)) {
      const visible = this._visibleAnswers();
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
      if (this.phase === 'reveal') {
        // 未開示の回答は、本人と（匿名モードの）主催者にだけ見せる。主催者にも作者は伏せる。
        view.unrevealed = hidden
          .filter((a) => a.ownerId === pid || (anonymous && isHost))
          .sort((a, b) => (a.id < b.id ? -1 : 1))
          .map((a) => ({ ...toView(a), author: anonymous ? null : nameOf(a.ownerId) }));
      }
    }
    if (this.phase === 'vote') view.myVote = this.votes.get(pid) ?? null;
    if (this.phase === 'result' && this.result) {
      view.result = {
        winners: [...this.result.winners],
        tie: this.result.tie,
        tallies: this.result.tallies.map((t) => {
          const a = this._findAnswer(t.answerId);
          return { answerId: t.answerId, text: a?.text ?? '', votes: t.votes, author: nameOf(t.ownerId) };
        }),
      };
    }
    return view;
  }
}
