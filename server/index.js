// 起動。お題の保存先（DB）をつなぎ、サーバーを組み立てて、待ち受けを始める。

import { TopicPool } from './topics.js';
import { createStoreFromEnv } from './store.js';
import { createApp } from './app.js';

const PORT = Number(process.env.PORT ?? 3000);

const topics = new TopicPool();
topics.attach(createStoreFromEnv()); // DATABASE_URL があれば、題材と報告を保存・読み込み。無ければ、メモリだけ（起動は待たない）

const app = createApp({ topics });
app.listen(PORT).then(() => console.log(`朝それ: http://localhost:${PORT}`));
