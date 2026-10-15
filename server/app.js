// サーバー全体の組み立て：HTTP、WebSocket、部屋の一覧（Hub）、定期処理。
// listen はしない（index.js が行う。テストは空きポートで起動する）。DB への接続（topics.attach）も、ここではしない。

import http from 'node:http';
import { computeBuild, createRequestHandler } from './http.js';
import { Hub } from './hub.js';
import { createWebSocketServer, pingClients } from './socket.js';

const TICK_MS = 1000;
const PING_MS = 25000;

// topics は TopicPool。publicDir・adminToken を省くと、本物の public/ と環境変数 ADMIN_TOKEN を使う。
export function createApp({ topics, publicDir, adminToken, tickMs = TICK_MS, pingMs = PING_MS }) {
  const build = computeBuild(publicDir);
  const startedAt = Date.now();
  const hub = new Hub();
  const server = http.createServer(createRequestHandler({ topics, rooms: hub.rooms, build, startedAt, publicDir, adminToken }));
  const wss = createWebSocketServer({ server, hub, topics, build });

  const timers = [
    setInterval(() => pingClients(wss), pingMs),
    setInterval(() => hub.tick(), tickMs), // 猶予を過ぎた主催者・出題者の引き継ぎと、空き部屋の終了
  ];

  // 待ち受けを始める。port に 0 を渡すと空いているポートが選ばれる。実際のポートを返す。
  const listen = (port) => new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => resolve(server.address().port));
  });

  // 定期処理を止め、全ての接続を切って、待ち受けを終える
  const close = () => {
    for (const t of timers) clearInterval(t);
    for (const ws of wss.clients) ws.terminate();
    wss.close();
    server.close();
  };

  return { server, wss, hub, build, listen, close };
}
