// お題の保存先。DATABASE_URL（例: Neon の接続URL）があればPostgresに、なければ何もしない（メモリだけで動く）。
//
// テーブル
//   themes(theme 主キー, source 'seed'|'user', created_at)  … 題材の一覧
//   theme_flags(theme, client_id, created_at)               … 「おかしい」報告。(theme, client_id) は重複しない
//
// 管理（戻したいときなど）は、Neon の SQL Editor から、たとえば次のように行う。
//   報告を一覧する : SELECT theme, count(*) AS n FROM theme_flags GROUP BY theme ORDER BY n DESC;
//   1つ戻す       : DELETE FROM theme_flags WHERE theme = '題材';
//   全部戻す       : DELETE FROM theme_flags;
//   題材を消す     : DELETE FROM theme_flags WHERE theme = '題材'; DELETE FROM themes WHERE theme = '題材';
//                   （シードに残っている題材は、次の起動で、また入る。シードのファイルからも消すこと）
// 書き換えたあとは、サーバーを再起動（Render の Manual Deploy → Restart）すると、反映される。

import pg from 'pg';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS themes (
  theme text PRIMARY KEY,
  source text NOT NULL DEFAULT 'user',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS theme_flags (
  theme text NOT NULL,
  client_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (theme, client_id)
);`;

export class PgStore {
  // pool は pg.Pool と同じ形のもの（テストでは pg-mem のものを渡す）
  constructor(pool) {
    this.pool = pool;
  }

  static fromUrl(url) {
    const pool = new pg.Pool({ connectionString: url, max: 3, connectionTimeoutMillis: 10000, idleTimeoutMillis: 30000 });
    pool.on('error', (e) => console.error('[db] 接続エラー:', e.message)); // 休止中の接続切れで落ちないように
    return new PgStore(pool);
  }

  // 表を作り、シードの題材を足し（すでにあるものは、そのまま）、保存済みの題材と報告を返す。
  async load(seedThemes) {
    await this.pool.query(SCHEMA);
    for (let i = 0; i < seedThemes.length; i += 100) { // 通信の往復を減らすため、100件ずつまとめて入れる
      const chunk = seedThemes.slice(i, i + 100);
      const values = chunk.map((_, j) => `($${j + 1}, 'seed')`).join(', ');
      await this.pool.query(`INSERT INTO themes (theme, source) VALUES ${values} ON CONFLICT DO NOTHING`, chunk);
    }
    const themes = (await this.pool.query('SELECT theme, source FROM themes')).rows;
    const flags = (await this.pool.query('SELECT theme, client_id FROM theme_flags')).rows;
    return { themes, flags };
  }

  async addTheme(theme, source = 'user') {
    await this.pool.query('INSERT INTO themes (theme, source) VALUES ($1, $2) ON CONFLICT DO NOTHING', [theme, source]);
  }

  async addFlag(theme, clientId) {
    await this.pool.query('INSERT INTO theme_flags (theme, client_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [theme, clientId]);
  }

  async close() {
    await this.pool.end();
  }
}

// DATABASE_URL が無ければ null（メモリだけで動く）
export function createStoreFromEnv(env = process.env) {
  return env.DATABASE_URL ? PgStore.fromUrl(env.DATABASE_URL) : null;
}
