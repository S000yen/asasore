// お題の部品（ひらがな・題材）の抽選・登録・報告。
// 題材 = カテゴリと尺度を1セットにしたもの（例：「面白いもの」「東大生あるある」）。
//
// - 題材は、シード（seed/themes.json）と、運用中に手入力で増えたものから成る。
// - 「おかしい」の報告は、端末（clientId）ごとに1回だけ数える。報告した端末が増えるほど出にくくなり、
//   一定数（FLAG_HIDE_AT）に達するとランダムでは出さない。
// - 保存先（store.js）があれば、題材と報告を保存し、起動時に読み戻す。無ければ、メモリだけで動く。
//   保存先が使えなくなっても、ゲームは止めない（ログに出して、メモリだけで続ける）。

import { readFileSync } from 'node:fs';
import { randomInt } from 'node:crypto';

const seedPath = new URL('../seed/themes.json', import.meta.url);

// 使いやすい頭文字だけを、重み付きで抽選する（ん・を・小書き文字・濁音・半濁音は除く）。
const ROWS = ['あいうえお', 'かきくけこ', 'さしすせそ', 'たちつてと', 'なにぬねの', 'はひふへほ', 'まみむめも', 'やゆよ', 'らりるれろ', 'わ'];
const HIRAGANA_WEIGHTS = ROWS.join('').split('').map((ch) => [ch, 1]); // 答えにくい文字も含め、どれも同じ確率

const DEFAULT_HIDE_AT = 5; // 報告した端末がこの数に達したら、ランダムでは出さない
const RETRY_MS = 30_000;

function weightedPick(pairs) {
  const total = pairs.reduce((s, [, w]) => s + w, 0);
  let r = Math.random() * total;
  for (const [value, w] of pairs) {
    if (r < w) return value;
    r -= w;
  }
  return pairs[pairs.length - 1][0];
}

export class TopicPool {
  constructor(seedThemes = JSON.parse(readFileSync(seedPath, 'utf8')), { hideAt = Number(process.env.FLAG_HIDE_AT) || DEFAULT_HIDE_AT } = {}) {
    this.seed = [...seedThemes];
    this.hideAt = hideAt;
    this.themes = new Map(); // 題材 -> { flaggers: Set<clientId> }
    for (const t of seedThemes) this._ensure(t);
    this.pairs = new Set(); // 「ひらがな＋題材」の組み合わせ（登録済みのもの）
    this.store = null;
    this.ready = false;
  }

  _ensure(theme) {
    if (!this.themes.has(theme)) this.themes.set(theme, { flaggers: new Set() });
    return this.themes.get(theme);
  }

  has(theme) {
    return this.themes.has(theme);
  }

  // 報告した端末が n のときの出やすさ。1 → 0.5 → 0.25 → …、hideAt に達したら 0
  weightOf(theme) {
    const n = this.themes.get(theme)?.flaggers.size ?? 0;
    return n >= this.hideAt ? 0 : 0.5 ** n;
  }

  randomHiragana(exclude) {
    const pool = HIRAGANA_WEIGHTS.filter(([ch]) => ch !== exclude);
    return weightedPick(pool);
  }

  // filter = { used: Set, blocked: Set }（その部屋で使った題材・報告された題材）。
  // 候補が尽きたら、used だけをリセットして引き直す（blocked は戻さない）。
  randomTheme(exclude, filter = {}) {
    const used = filter.used ?? new Set();
    const blocked = filter.blocked ?? new Set();
    const pick = (skipUsed) => [...this.themes.keys()]
      .filter((t) => t !== exclude && !blocked.has(t) && !(skipUsed && used.has(t)))
      .map((t) => [t, this.weightOf(t)])
      .filter(([, w]) => w > 0);
    let cands = pick(true);
    if (cands.length === 0) {
      used.clear();
      cands = pick(false);
    }
    if (cands.length === 0) return exclude; // 引ける題材が1つもない（手入力で続けられる）
    return weightedPick(cands);
  }

  // 現在のお題の一部（または全部）を引き直す。part: 'hiragana' | 'theme' | 'both'
  draw(current, part, filter = {}) {
    const cur = current ?? {};
    const hiragana = part === 'theme' ? cur.hiragana ?? this.randomHiragana() : this.randomHiragana(cur.hiragana);
    const theme = part === 'hiragana' ? cur.theme ?? this.randomTheme(undefined, filter) : this.randomTheme(cur.theme, filter);
    return { hiragana, theme };
  }

  // お題が確定したときに呼ぶ。手動で入れた未登録の題材・組み合わせはここで登録（保存）される。
  register({ hiragana, theme }) {
    const newTheme = !this.themes.has(theme);
    this._ensure(theme);
    if (newTheme) this._persist(() => this.store.addTheme(theme, 'user'));
    const key = `${hiragana}\t${theme}`;
    const newPair = !this.pairs.has(key);
    this.pairs.add(key);
    return { newTheme, newPair };
  }

  // 「おかしい」の報告。同じ端末の2回目以降は数えない。登録されていない題材（手入力）は対象外。
  flag(theme, clientId) {
    const t = this.themes.get(theme);
    if (!t || !clientId) return { counted: false };
    if (t.flaggers.has(clientId)) return { counted: false, flags: t.flaggers.size };
    t.flaggers.add(clientId);
    this._persist(() => this.store.addFlag(theme, clientId));
    return { counted: true, flags: t.flaggers.size, hidden: t.flaggers.size >= this.hideAt };
  }

  // ---------- 保存先とのやりとり ----------

  // 保存先をつなぎ、保存済みの内容を読み込む。つながらなければ、メモリだけで動き、あとで再試行する。
  async attach(store, { retryMs = RETRY_MS, log = console } = {}) {
    this.store = store;
    if (!store) return false;
    try {
      const { themes, flags } = await store.load(this.seed);
      const savedThemes = new Set(themes.map((r) => r.theme));
      const savedFlags = new Set(flags.map((r) => `${r.theme}\t${r.client_id}`));
      // つながらなかった間にメモリだけで増えた題材・報告があれば、いま保存する
      for (const [theme, { flaggers }] of this.themes) {
        if (!savedThemes.has(theme)) await store.addTheme(theme, 'user');
        for (const id of flaggers) if (!savedFlags.has(`${theme}\t${id}`)) await store.addFlag(theme, id);
      }
      for (const { theme } of themes) this._ensure(theme);
      for (const { theme, client_id: clientId } of flags) this._ensure(theme).flaggers.add(clientId);
      this.ready = true;
      log.log(`[db] 題材 ${this.themes.size} 件、報告 ${flags.length} 件を読み込みました`);
      return true;
    } catch (e) {
      log.error('[db] 読み込めませんでした。メモリだけで続け、あとで再試行します:', e.message);
      this.ready = false;
      if (retryMs > 0) {
        this.retryTimer = setTimeout(() => this.attach(store, { retryMs, log }), retryMs);
        this.retryTimer.unref?.();
      }
      return false;
    }
  }

  // 保存は待たない。失敗してもゲームは続ける（ログだけ出す）。
  _persist(fn) {
    if (!this.store || !this.ready) return;
    Promise.resolve()
      .then(fn)
      .catch((e) => console.error('[db] 保存に失敗しました:', e.message));
  }
}
