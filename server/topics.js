// お題の部品（ひらがな・題材）の抽選と登録。
// 題材 = カテゴリと尺度を1セットにしたもの（例：「面白いもの」「東大生あるある」）。
// 今はメモリ上だけで持つ。SQLite（db.js）と評価の記録（ratings.js）は後で足す。

import { readFileSync } from 'node:fs';
import { randomInt } from 'node:crypto';

const seedPath = new URL('../seed/themes.json', import.meta.url);

// 使いやすい頭文字だけを、重み付きで抽選する（ん・を・小書き文字・濁音は除く）。
const ROWS = ['あいうえお', 'かきくけこ', 'さしすせそ', 'たちつてと', 'なにぬねの', 'はひふへほ', 'まみむめも', 'やゆよ', 'らりるれろ', 'わ'];
const RARE = new Set(['ぬ', 'ね', 'む', 'め', 'ゆ', 'へ', 'え', 'ろ', 'れ', 'わ']); // 答えが出にくい文字は半分の重み
const HIRAGANA_WEIGHTS = ROWS.join('').split('').map((ch) => [ch, RARE.has(ch) ? 1 : 2]);

function weightedPick(pairs) {
  const total = pairs.reduce((s, [, w]) => s + w, 0);
  let r = randomInt(total);
  for (const [value, w] of pairs) {
    if (r < w) return value;
    r -= w;
  }
  return pairs[0][0];
}

export class TopicPool {
  constructor(seedThemes = JSON.parse(readFileSync(seedPath, 'utf8'))) {
    this.themes = new Set(seedThemes);
    this.pairs = new Set(); // 「ひらがな＋題材」の組み合わせ（登録済みのもの）
  }

  randomHiragana(exclude) {
    const pool = HIRAGANA_WEIGHTS.filter(([ch]) => ch !== exclude);
    return weightedPick(pool);
  }

  randomTheme(exclude) {
    const list = [...this.themes].filter((t) => t !== exclude);
    return list.length > 0 ? list[randomInt(list.length)] : exclude;
  }

  // 現在のお題の一部（または全部）を引き直す。part: 'hiragana' | 'theme' | 'both'
  draw(current, part) {
    const cur = current ?? {};
    const hiragana = part === 'theme' ? cur.hiragana ?? this.randomHiragana() : this.randomHiragana(cur.hiragana);
    const theme = part === 'hiragana' ? cur.theme ?? this.randomTheme() : this.randomTheme(cur.theme);
    return { hiragana, theme };
  }

  // お題が確定したときに呼ぶ。手動で入れた未登録の題材・組み合わせはここで登録される。
  register({ hiragana, theme }) {
    const newTheme = !this.themes.has(theme);
    this.themes.add(theme);
    const key = `${hiragana}\t${theme}`;
    const newPair = !this.pairs.has(key);
    this.pairs.add(key);
    return { newTheme, newPair };
  }
}
