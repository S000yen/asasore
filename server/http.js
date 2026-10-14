// HTTP の受け付け：/health、/admin、public/ の静的ファイル配信。
// 部屋やお題の中身には触らない（/admin に、必要なものをそのまま渡すだけ）。

import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { handleAdmin } from './admin.js';

export const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

// 配信するファイルの版（中身から決める）。開きっぱなしの古い画面が、再接続のときに気づいて自分で読み込み直すために使う。
export function computeBuild(publicDir = PUBLIC_DIR) {
  try {
    const h = createHash('sha1');
    for (const f of ['index.html', 'app.js', 'style.css', 'howto.md']) h.update(readFileSync(path.join(publicDir, f)));
    return h.digest('hex').slice(0, 10);
  } catch { return 'dev'; }
}

// http.createServer に渡すリクエストの処理を作る。
// ctx は /admin に渡す { topics, rooms, startedAt } と、配信中の版 build。adminToken を省くと、環境変数 ADMIN_TOKEN を使う。
export function createRequestHandler({ topics, rooms, build, startedAt, publicDir = PUBLIC_DIR, adminToken }) {
  return async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/health') { // 動作確認と、休止からの復帰・定期アクセス用
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }).end('ok');
        return;
      }
      if (await handleAdmin(req, res, url, { topics, rooms, build, startedAt }, adminToken)) return;
      let rel = decodeURIComponent(url.pathname);
      if (rel.endsWith('/')) rel += 'index.html';
      const file = path.normalize(path.join(publicDir, rel));
      if (!file.startsWith(publicDir + path.sep)) {
        res.writeHead(403).end('forbidden');
        return;
      }
      let body = await readFile(file);
      if (path.basename(file) === 'index.html') body = Buffer.from(body.toString('utf8').replace('</head>', `  <meta name="build" content="${build}">\n</head>`));
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream',
        'Cache-Control': 'no-cache',
      });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  };
}
