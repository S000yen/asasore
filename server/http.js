// HTTP の受け付け：/health、/admin、public/ と shared/ の静的ファイル配信。
// 部屋やお題の中身には触らない（/admin に、必要なものをそのまま渡すだけ）。
//
// public/ はそのまま / 以下に、shared/（サーバーと画面が同じ定義を使うためのファイル）は /shared/ 以下に配信する。

import { readFile } from 'node:fs/promises';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { handleAdmin } from './admin.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PUBLIC_DIR = path.join(ROOT, 'public');
export const SHARED_DIR = path.join(ROOT, 'shared');
const SHARED_PREFIX = '/shared/';

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

// 配信するファイルの版の対象。画面の見た目や動きを決めるファイルだけで、画像などは含めない。
const BUILD_EXTENSIONS = new Set(['.html', '.js', '.css', '.md']);

// dir の下にある、版の対象のファイルを、dir からの相対パス（/ 区切り）で返す。並びは決まっている。
function listBuildFiles(dir, base = '') {
  const found = [];
  for (const entry of readdirSync(path.join(dir, base), { withFileTypes: true })) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...listBuildFiles(dir, rel));
    else if (BUILD_EXTENSIONS.has(path.extname(entry.name))) found.push(rel);
  }
  return found.sort();
}

// 配信するファイルの版（中身とパスから決める）。開きっぱなしの古い画面が、再接続のときに気づいて自分で読み込み直すために使う。
// public/ と shared/ の下の、版の対象のファイルをすべて含める（画面を複数のファイルに分けても、どれかが変われば版が変わる）。
// shared/ が無ければ無視する。public/ が読めなければ 'dev'。
export function computeBuild(publicDir = PUBLIC_DIR, sharedDir = SHARED_DIR) {
  try {
    const hash = createHash('sha1');
    for (const [label, dir, optional] of [['public', publicDir, false], ['shared', sharedDir, true]]) {
      if (optional && !existsSync(dir)) continue;
      for (const rel of listBuildFiles(dir)) {
        hash.update(`${label}/${rel}\0`);
        hash.update(readFileSync(path.join(dir, rel)));
      }
    }
    return hash.digest('hex').slice(0, 10);
  } catch { return 'dev'; }
}

// http.createServer に渡すリクエストの処理を作る。
// ctx は /admin に渡す { topics, rooms, startedAt } と、配信中の版 build。adminToken を省くと、環境変数 ADMIN_TOKEN を使う。
export function createRequestHandler({ topics, rooms, build, startedAt, publicDir = PUBLIC_DIR, sharedDir = SHARED_DIR, adminToken }) {
  return async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/health') { // 動作確認と、休止からの復帰・定期アクセス用
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }).end('ok');
        return;
      }
      if (await handleAdmin(req, res, url, { topics, rooms, build, startedAt }, adminToken)) return;
      const isShared = url.pathname.startsWith(SHARED_PREFIX);
      const root = isShared ? sharedDir : publicDir;
      let rel = decodeURIComponent(isShared ? url.pathname.slice(SHARED_PREFIX.length - 1) : url.pathname);
      if (rel.endsWith('/')) rel += 'index.html';
      const file = path.normalize(path.join(root, rel));
      if (!file.startsWith(root + path.sep)) {
        res.writeHead(403).end('forbidden');
        return;
      }
      let body = await readFile(file);
      if (!isShared && path.basename(file) === 'index.html') body = Buffer.from(body.toString('utf8').replace('</head>', `  <meta name="build" content="${build}">\n</head>`));
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
